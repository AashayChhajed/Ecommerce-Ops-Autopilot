import 'dotenv/config'; // ESM side-effect import — runs BEFORE other app modules (critical for PG vars)

import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import dotenv from 'dotenv';

// Also load .env from project root (relative to this file: backend/src/server.js)
const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, '..', '..', '.env') });
// Fallback: load from cwd's .env (for backward compat / alternative setups)
dotenv.config();

import http from 'node:http';
import { initializeDatabase, query, closeDatabase } from './database.js';
import {
  productFromShopify, shopifyBaseUrl, toApiProduct,
  orderFromShopify, toApiOrder, toApiInventoryAlert,
  toApiActivityLog, toApiSchedulerRun, toApiDescription,
  logActivity, auditInventory,
  generateSingleDescription, generateMissingDescriptions,
  sendOrderNotifications,
} from './lib.js';
import { startScheduler } from './scheduler.js';

const port = Number(process.env.PORT ?? 4000);
const allowedOrigin = process.env.CORS_ORIGIN ?? 'http://localhost:3000';
const shopifyToken = process.env.SHOPIFY_ACCESS_TOKEN;

// ──────────────────────────────────────────────
// Response helpers
// ──────────────────────────────────────────────
function send(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-API-KEY',
  });
  res.end(JSON.stringify(body));
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(new Error('Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

// ──────────────────────────────────────────────
// Shopify fetcher with retry
// ──────────────────────────────────────────────
async function shopifyFetch(path) {
  if (!shopifyToken) throw new Error('SHOPIFY_ACCESS_TOKEN is not configured');
  const url = `${shopifyBaseUrl(process.env.SHOPIFY_SHOP_NAME, process.env.SHOPIFY_API_VERSION)}${path}`;
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { 'X-Shopify-Access-Token': shopifyToken } });
      if (!response.ok) throw new Error(`Shopify returned ${response.status} ${response.statusText}`);
      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise((r) => setTimeout(r, attempt * 1000));
    }
  }
  throw new Error(`Shopify fetch failed after 3 attempts: ${lastError.message}`);
}

// ──────────────────────────────────────────────
// Core sync functions (exported for scheduler)
// ──────────────────────────────────────────────
export async function syncProducts() {
  const limit = Number(process.env.SHOPIFY_PRODUCT_LIMIT) || 250; // Shopify max is 250
  const data = await shopifyFetch(`/products.json?limit=${limit}&status=active`);
  const rawProducts = data.products ?? [];
  const products = rawProducts.map(productFromShopify);
  const shopifyIds = products.map((p) => p.shopifyProductId);

  if (products.length) {
    const values = products.map((_, i) => {
      const b = i * 7 + 1;
      return `($${b},$${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},NOW(),NOW())`;
    });
    const flat = products.flatMap((p) => [
      p.shopifyProductId, p.title, p.description, p.vendor,
      p.status, p.inventory, p.price,
    ]);
    await query(`
      INSERT INTO products (shopify_product_id, title, description, vendor, status, inventory, price, created_at, updated_at)
      VALUES ${values.join(',')}
      ON CONFLICT (shopify_product_id) DO UPDATE SET
        title = EXCLUDED.title, description = EXCLUDED.description, vendor = EXCLUDED.vendor,
        status = EXCLUDED.status, inventory = EXCLUDED.inventory, price = EXCLUDED.price,
        updated_at = NOW()
    `, flat);
  }

  // Remove products no longer on Shopify
  if (shopifyIds.length) {
    const deleted = await query(
      `DELETE FROM products WHERE shopify_product_id != ALL($1::bigint[])`,
      [shopifyIds]
    );
    if (deleted.rowCount > 0) {
      await logActivity('PRODUCT_CLEANUP', `Removed ${deleted.rowCount} stale product(s).`, 'INFO');
    }
  }

  // Resolve inventory alerts for products now above threshold
  await query(`
    UPDATE inventory_alerts ia SET resolved = TRUE
    FROM products p
    WHERE ia.product_id = p.id AND p.inventory > ia.threshold AND ia.resolved = FALSE
  `);

  await logActivity('PRODUCT_SYNC', `Synchronized ${products.length} product(s) from Shopify.`, 'SUCCESS');
  return { productsSynced: products.length };
}

export async function syncOrders() {
  const data = await shopifyFetch('/orders.json?status=any&limit=250');
  const orders = (data.orders ?? []).map(orderFromShopify);

  if (orders.length) {
    const values = orders.map((_, i) => {
      const b = i * 6 + 1;
      return `($${b},$${b+1},$${b+2},$${b+3},$${b+4},$${b+5})`;
    });
    const flat = orders.flatMap((o) => [
      o.shopifyOrderId, o.customerName, o.email, o.status, o.total,
      o.createdAt || new Date().toISOString(),
    ]);
    await query(`
      INSERT INTO orders (shopify_order_id, customer_name, email, status, total, created_at)
      VALUES ${values.join(',')}
      ON CONFLICT (shopify_order_id) DO UPDATE SET
        customer_name = EXCLUDED.customer_name, email = EXCLUDED.email,
        status = EXCLUDED.status, total = EXCLUDED.total
    `, flat);
  }

  await logActivity('ORDER_SYNC', `Synchronized ${orders.length} order(s) from Shopify.`, 'SUCCESS');
  return { ordersSynced: orders.length };
}

export async function fullSync() {
  const startedAt = Date.now();
  const results = { productsSynced: 0, ordersSynced: 0, alertsCreated: 0, errors: [] };

  const safe = async (label, fn) => {
    try { return await fn(); } catch (err) {
      const msg = `${label}: ${err.message}`;
      console.error('[fullSync]', msg);
      await logActivity(label.toUpperCase().replace(/\s/g, '_'), msg, 'ERROR');
      results.errors.push(msg);
      return null;
    }
  };

  const pr = await safe('Product Sync', syncProducts);
  if (pr) results.productsSynced = pr.productsSynced;

  const or = await safe('Order Sync', syncOrders);
  if (or) results.ordersSynced = or.ordersSynced;

  const ir = await safe('Inventory Audit', auditInventory);
  if (ir) results.alertsCreated = ir.alertsCreated;

  const hasErrors = results.errors.length > 0;
  await logActivity(
    'FULL_SYNC',
    hasErrors
      ? `Sync finished with ${results.errors.length} error(s).`
      : `Full sync complete: ${results.productsSynced} products, ${results.ordersSynced} orders.`,
    hasErrors ? 'WARNING' : 'SUCCESS'
  );

  return {
    status: hasErrors ? 'PARTIAL' : 'SUCCESS',
    message: hasErrors
      ? `Synced ${results.productsSynced}p / ${results.ordersSynced}o. Errors: ${results.errors.join('; ')}`
      : `Synced ${results.productsSynced} products, ${results.ordersSynced} orders, ${results.alertsCreated} alerts.`,
    productsSynced: results.productsSynced,
    ordersSynced: results.ordersSynced,
    alertsCreated: results.alertsCreated,
    durationMs: Date.now() - startedAt,
  };
}

// ──────────────────────────────────────────────
// KPI aggregation
// ──────────────────────────────────────────────
async function getKpis() {
  const [
    { rows: [products] },
    { rows: [orders] },
    { rows: [alerts] },
    { rows: [descriptions] },
    { rows: [schedulerRuns] },
    { rows: recentLogs },
  ] = await Promise.all([
    query(`SELECT COUNT(*)::int AS total, COALESCE(SUM(price), 0)::float AS total_value,
           COALESCE(SUM(inventory), 0)::int AS total_inventory FROM products`),
    query(`SELECT COUNT(*)::int AS total, COALESCE(SUM(total), 0)::float AS total_revenue FROM orders`),
    query(`SELECT COUNT(*)::int AS total FROM inventory_alerts WHERE resolved = FALSE`),
    query(`SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE approved = TRUE)::int AS approved FROM descriptions`),
    query(`SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE status = 'SUCCESS')::int AS succeeded FROM scheduler_runs`),
    query(`SELECT type, message, status, created_at FROM activity_logs ORDER BY created_at DESC LIMIT 5`),
  ]);

  return {
    totalProducts: products.total,
    totalProductValue: Number(products.total_value.toFixed(2)),
    totalInventory: products.total_inventory,
    totalOrders: orders.total,
    totalRevenue: Number(orders.total_revenue.toFixed(2)),
    activeAlerts: alerts.total,
    totalDescriptions: descriptions.total,
    approvedDescriptions: descriptions.approved,
    schedulerRuns: schedulerRuns.total,
    schedulerSuccess: schedulerRuns.succeeded,
    recentActivity: recentLogs.map(toApiActivityLog),
  };
}

// ──────────────────────────────────────────────
// Router
// ──────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204, {});

  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;
  const method = req.method;

  try {
    // ── Health ──────────────────────────────────
    if (method === 'GET' && (path === '/health' || path === '/actuator/health')) {
      await query('SELECT 1');
      return send(res, 200, { status: 'UP', components: { db: { status: 'UP' } } });
    }

    // ── KPIs ────────────────────────────────────
    if (method === 'GET' && path === '/api/kpis') {
      return send(res, 200, await getKpis());
    }

    // ── Products ────────────────────────────────
    if (method === 'GET' && (path === '/api/products' || path === '/api/shopify/products')) {
      const search = url.searchParams.get('search') ?? '';
      const status = url.searchParams.get('status') ?? '';
      let sql = 'SELECT * FROM products';
      const params = [];
      const conditions = [];
      if (search) { params.push(`%${search}%`); conditions.push(`title ILIKE $${params.length}`); }
      if (status) { params.push(status); conditions.push(`status = $${params.length}`); }
      if (conditions.length) sql += ` WHERE ${conditions.join(' AND ')}`;
      sql += ' ORDER BY updated_at DESC';
      const { rows } = await query(sql, params);
      return send(res, 200, rows.map(toApiProduct));
    }

    const productMatch = path.match(/^\/api\/products\/(\d+)$/);
    if (method === 'GET' && productMatch) {
      const { rows } = await query('SELECT * FROM products WHERE id = $1', [productMatch[1]]);
      return rows.length ? send(res, 200, toApiProduct(rows[0])) : send(res, 404, { message: 'Product not found' });
    }

    // ── Orders ──────────────────────────────────
    if (method === 'GET' && (path === '/api/orders' || path === '/api/shopify/orders')) {
      const status = url.searchParams.get('status') ?? '';
      let sql = 'SELECT * FROM orders';
      const params = [];
      if (status) { params.push(status); sql += ` WHERE status = $1`; }
      sql += ' ORDER BY created_at DESC';
      const { rows } = await query(sql, params);
      return send(res, 200, rows.map(toApiOrder));
    }

    // ── Inventory ───────────────────────────────
    if (method === 'GET' && (path === '/api/inventory' || path === '/api/shopify/inventory')) {
      const lowStockOnly = url.searchParams.get('lowStockOnly') === 'true';
      let sql = `
        SELECT ia.*, p.title as product_title, p.shopify_product_id
        FROM inventory_alerts ia
        JOIN products p ON p.id = ia.product_id
      `;
      if (lowStockOnly) sql += ' WHERE ia.resolved = FALSE';
      sql += ' ORDER BY ia.created_at DESC';
      const { rows } = await query(sql);
      return send(res, 200, rows.map(toApiInventoryAlert));
    }

    const thresholdMatch = path.match(/^\/api\/inventory\/threshold\/(\d+)$/);
    if (method === 'PUT' && thresholdMatch) {
      const body = await parseBody(req);
      const threshold = Number(body.threshold);
      if (!Number.isFinite(threshold) || threshold < 0) {
        return send(res, 400, { message: 'Invalid threshold value' });
      }
      const { rows } = await query(
        'UPDATE inventory_alerts SET threshold = $1 WHERE id = $2 RETURNING *',
        [threshold, thresholdMatch[1]]
      );
      return rows.length
        ? send(res, 200, toApiInventoryAlert(rows[0]))
        : send(res, 404, { message: 'Alert not found' });
    }

    // ── Order Notifications ─────────────────────
    if (method === 'POST' && path === '/api/orders/notify') {
      return send(res, 200, await sendOrderNotifications());
    }

    // ── Shopify Sync ────────────────────────────
    if (method === 'POST' && path === '/api/shopify/sync') {
      return send(res, 200, await fullSync());
    }

    // ── Descriptions ────────────────────────────
    if (method === 'GET' && path === '/api/descriptions/pending') {
      const { rows } = await query(`
        SELECT d.*, p.title as product_title, p.vendor
        FROM descriptions d JOIN products p ON p.id = d.product_id
        WHERE d.approved = FALSE
        ORDER BY d.generated_at DESC
      `);
      return send(res, 200, rows.map(toApiDescription));
    }

    // Batch generation (must come before the :id route)
    if (method === 'POST' && path === '/api/descriptions/generate/batch') {
      const result = await generateMissingDescriptions();
      return send(res, 200, result);
    }

    // ── AI Description Generation (two URL patterns) ──
    // Primary: /api/products/:id/generate-description
    const productGenMatch = path.match(/^\/api\/products\/(\d+)\/generate-description$/);
    // Backward-compatible alias: /api/descriptions/generate/:id
    const descGenerateMatch = path.match(/^\/api\/descriptions\/generate\/(\d+)$/);

    const genMatch = productGenMatch || descGenerateMatch;
    if (method === 'POST' && genMatch) {
      const productId = genMatch[1];
      const { rows: productRows } = await query('SELECT * FROM products WHERE id = $1', [productId]);
      if (!productRows.length) return send(res, 404, { message: 'Product not found' });

      // Parse optional tone from request body
      let tone;
      try {
        const body = await parseBody(req);
        tone = body?.tone;
      } catch {
        // Body is optional — ignore parse errors
      }

      // Normalize: empty string means default (no tone)
      if (tone === '') tone = undefined;

      const validTones = ['professional', 'friendly', 'playful', 'expert'];
      if (tone && !validTones.includes(tone)) {
        return send(res, 400, {
          message: `Invalid tone "${tone}". Valid options: ${validTones.join(', ')}`,
        });
      }

      const desc = await generateSingleDescription(productRows[0], { tone });
      if (!desc) return send(res, 200, { message: 'Description already exists' });
      return send(res, 200, toApiDescription(desc));
    }

    const descApproveMatch = path.match(/^\/api\/descriptions\/approve\/(\d+)$/);
    if (method === 'POST' && descApproveMatch) {
      const body = await parseBody(req);
      const descId = descApproveMatch[1];
      const { rows: descRows } = await query('SELECT * FROM descriptions WHERE id = $1', [descId]);
      if (!descRows.length) return send(res, 404, { message: 'Description not found' });

      const finalText = body.editedText || descRows[0].generated_description;
      await query(
        `UPDATE descriptions SET approved = TRUE, generated_description = $1 WHERE id = $2`,
        [finalText, descId]
      );
      await query(
        `UPDATE products SET description = $1, updated_at = NOW() WHERE id = $2`,
        [finalText, descRows[0].product_id]
      );
      await logActivity('DESCRIPTION_APPROVED', `Description #${descId} approved and applied to product #${descRows[0].product_id}.`, 'SUCCESS');
      return send(res, 200, { status: 'APPROVED', descriptionId: Number(descId), publishedAt: new Date().toISOString() });
    }

    // ── Scheduler Status ─────────────────────────
    if (method === 'GET' && path === '/api/scheduler/status') {
      const { rows } = await query(`
        SELECT DISTINCT ON (job_name) *
        FROM scheduler_runs
        ORDER BY job_name, started DESC
      `);
      return send(res, 200, rows.map(toApiSchedulerRun));
    }

    if (method === 'GET' && path === '/api/scheduler/runs') {
      const { rows } = await query(`
        SELECT * FROM scheduler_runs ORDER BY started DESC LIMIT 50
      `);
      return send(res, 200, rows.map(toApiSchedulerRun));
    }

    // ── Activity Logs ────────────────────────────
    if (method === 'GET' && path === '/api/activity-logs') {
      const type = url.searchParams.get('type') ?? '';
      const limit = Math.min(Number(url.searchParams.get('limit') ?? 100), 500);
      let sql = 'SELECT * FROM activity_logs';
      const params = [];
      if (type) { params.push(type); sql += ` WHERE type = $1`; }
      sql += ` ORDER BY created_at DESC LIMIT ${limit}`;
      const { rows } = await query(sql, params);
      return send(res, 200, rows.map(toApiActivityLog));
    }

    // ── 404 ──────────────────────────────────────
    return send(res, 404, { message: 'Route not found', path });
  } catch (error) {
    console.error('[Server Error]', error);
    await logActivity('SERVER_ERROR', error.message, 'ERROR').catch(() => {});
    return send(res, path.includes('/shopify/') ? 502 : 500, {
      message: error.message,
      timestamp: new Date().toISOString(),
    });
  }
});

// ──────────────────────────────────────────────
// Bootstrap
// ──────────────────────────────────────────────
async function start() {
  await initializeDatabase();
  startScheduler({ fullSync, auditInventory, sendOrderNotifications, generateMissingDescriptions, logActivity });
  server.listen(port, () => {
    console.log(`\n🚀 E-Commerce Autopilot Backend`);
    console.log(`   Listening: http://localhost:${port}`);
    console.log(`   Health:    http://localhost:${port}/actuator/health`);
    console.log(`   KPIs:      http://localhost:${port}/api/kpis\n`);
  });
}

process.on('SIGINT', async () => {
  console.log('\nShutting down gracefully...');
  server.close();
  await closeDatabase();
  process.exit(0);
});

// Only auto-start when run directly (not imported by tests or other modules)
if (!process.env.AUTOPILOT_SKIP_START) {
  start().catch((error) => {
    console.error('Failed to start backend:', error);
    process.exit(1);
  });
}
