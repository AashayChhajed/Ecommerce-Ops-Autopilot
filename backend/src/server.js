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
import { initializeDatabase, markOrphanedSchedulerRunsFailed, fetchMockChannelSeedData, query, closeDatabase } from './database.js';
import {
  productFromShopify, shopifyBaseUrl, toApiProduct,
  orderFromShopify, toApiOrder, toApiInventoryAlert,
  toApiActivityLog, toApiSchedulerRun, toApiDescription,
  toApiDescriptionSettings, toApiDescriptionMetrics,
  logActivity, auditInventory,
  generateSingleDescription, generateMissingDescriptions,
  getBrandVoiceSettings, updateBrandVoiceSettings,
  getDescriptionMetrics,
  sendOrderNotifications,
  getUnifiedInventory,
  updateWarehouseQuantity,
  updateChannelProductQuantity,
  syncMockChannel,
} from './lib.js';
import { sendOrderNotification, sendLowStockAlert } from './email/index.js';
import { startScheduler } from './scheduler.js';
import {
  channelConnectors,
  MOCK_CHANNEL_CODES,
  initializeMockData,
  getMockInventory,
  updateMockQuantityByProductId,
} from './channels/index.js';
import {
  placeChannelOrder,
  allocateOrderItems,
  releaseOrderAllocation,
  fulfillOrderAllocation,
  reconcileChannelListings,
  getOrderItems,
  checkOrderFulfillable,
  getSafetyBufferPercent,
  updateSafetyBufferPercent,
} from './orderGuard.js';
import { toApiOrderItem } from './lib.js';

const port = Number(process.env.PORT ?? 4000);
const allowedOrigin = process.env.CORS_ORIGIN ?? 'http://localhost:3000';
const shopifyToken = process.env.SHOPIFY_ACCESS_TOKEN;
let shopifySyncCooldownUntil = 0;

function getShopifySyncCooldownMs() {
  return Number(process.env.SHOPIFY_SYNC_BACKOFF_MS ?? 30 * 60 * 1000);
}

function isShopifySyncDisabled() {
  return String(process.env.SHOPIFY_SYNC_ENABLED ?? 'true').toLowerCase() === 'false';
}

function setShopifySyncCooldown(ms) {
  shopifySyncCooldownUntil = Date.now() + ms;
}

function getShopifySyncCooldownRemainingMs() {
  return Math.max(0, shopifySyncCooldownUntil - Date.now());
}

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
  if (isShopifySyncDisabled()) {
    await logActivity('PRODUCT_SYNC', 'Skipped Shopify product sync because SHOPIFY_SYNC_ENABLED=false.', 'INFO');
    return { productsSynced: 0, skipped: true, reason: 'shopify_sync_disabled' };
  }

  const cooldownRemainingMs = getShopifySyncCooldownRemainingMs();
  if (cooldownRemainingMs > 0) {
    await logActivity(
      'PRODUCT_SYNC',
      `Skipped Shopify product sync because the last failure is still cooling down for ${Math.ceil(cooldownRemainingMs / 60000)} minute(s).`,
      'WARNING'
    );
    return { productsSynced: 0, skipped: true, reason: 'shopify_sync_cooldown' };
  }

  const limit = Number(process.env.SHOPIFY_PRODUCT_LIMIT) || 250; // Shopify max is 250
  let data;
  try {
    data = await shopifyFetch(`/products.json?limit=${limit}&status=active`);
  } catch (err) {
    const cooldownMs = getShopifySyncCooldownMs();
    setShopifySyncCooldown(cooldownMs);
    await logActivity(
      'PRODUCT_SYNC',
      `Skipped Shopify product sync for ${Math.ceil(cooldownMs / 60000)} minute(s) after fetch failure: ${err.message}`,
      'WARNING'
    );
    return { productsSynced: 0, skipped: true, reason: err.message };
  }

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
  if (isShopifySyncDisabled()) {
    await logActivity('ORDER_SYNC', 'Skipped Shopify order sync because SHOPIFY_SYNC_ENABLED=false.', 'INFO');
    return { ordersSynced: 0, skipped: true, reason: 'shopify_sync_disabled' };
  }

  const cooldownRemainingMs = getShopifySyncCooldownRemainingMs();
  if (cooldownRemainingMs > 0) {
    await logActivity(
      'ORDER_SYNC',
      `Skipped Shopify order sync because the last failure is still cooling down for ${Math.ceil(cooldownRemainingMs / 60000)} minute(s).`,
      'WARNING'
    );
    return { ordersSynced: 0, skipped: true, reason: 'shopify_sync_cooldown' };
  }

  let data;
  try {
    data = await shopifyFetch('/orders.json?status=any&limit=250');
  } catch (err) {
    const cooldownMs = getShopifySyncCooldownMs();
    setShopifySyncCooldown(cooldownMs);
    await logActivity(
      'ORDER_SYNC',
      `Skipped Shopify order sync for ${Math.ceil(cooldownMs / 60000)} minute(s) after fetch failure: ${err.message}`,
      'WARNING'
    );
    return { ordersSynced: 0, skipped: true, reason: err.message };
  }

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
    // RETURNING (xmax = 0) detects rows that were freshly INSERTed vs updated,
    // so we only run the over-order guard for brand-new orders.
    const { rows: upserted } = await query(`
      INSERT INTO orders (shopify_order_id, customer_name, email, status, total, created_at)
      VALUES ${values.join(',')}
      ON CONFLICT (shopify_order_id) DO UPDATE SET
        customer_name = EXCLUDED.customer_name, email = EXCLUDED.email,
        status = EXCLUDED.status, total = EXCLUDED.total
      RETURNING id, shopify_order_id, (xmax = 0) AS is_new
    `, flat);

    // ── Over-Order Guard for new Shopify orders ────────────────────────────
    const newOrderMap = new Map(
      upserted.filter((r) => r.is_new).map((r) => [Number(r.shopify_order_id), Number(r.id)])
    );
    if (newOrderMap.size > 0) {
      // Build product lookup: Shopify line items carry product_id and sku.
      const rawOrders = data.orders ?? [];
      const byShopifyId = new Map();
      const bySku = new Map();
      for (const raw of rawOrders) {
        for (const li of raw.line_items ?? []) {
          if (li.product_id) byShopifyId.set(Number(li.product_id), true);
          if (li.sku) bySku.set(String(li.sku), true);
        }
      }
      const lookup = {};
      if (byShopifyId.size) {
        const { rows } = await query(
          `SELECT id, shopify_product_id FROM products WHERE shopify_product_id = ANY($1::bigint[])`,
          [[...byShopifyId.keys()]]
        );
        for (const r of rows) lookup[r.shopify_product_id] = Number(r.id);
      }
      if (bySku.size) {
        const { rows } = await query(
          `SELECT id, sku FROM products WHERE sku = ANY($1)`,
          [[...bySku.keys()]]
        );
        for (const r of rows) if (!lookup[r.sku]) lookup[r.sku] = Number(r.id);
      }

      for (const raw of rawOrders) {
        const orderId = newOrderMap.get(Number(raw.id));
        if (!orderId) continue;
        const items = (raw.line_items ?? [])
          .map((li) => {
            const productId =
              lookup[Number(li.product_id)] ?? lookup[String(li.sku)] ?? null;
            return productId
              ? { productId, quantity: Math.max(1, Number(li.quantity) || 1), channelSku: li.sku ?? null }
              : null;
          })
          .filter(Boolean);
        if (!items.length) continue;
        try {
          const result = await allocateOrderItems(orderId, items);
          await logActivity(
            'ORDER_ALLOCATION',
            `Shopify order #${raw.id} ${result.status === 'ALLOCATED' ? 'accepted — warehouse stock reserved' : 'rejected at intake (insufficient warehouse stock)'}.`,
            result.status === 'ALLOCATED' ? 'SUCCESS' : 'WARNING'
          );
        } catch (err) {
          console.error(`[OrderGuard] Failed to allocate Shopify order #${raw.id}:`, err.message);
        }
      }
    }
  }

  await logActivity('ORDER_SYNC', `Synchronized ${orders.length} order(s) from Shopify.`, 'SUCCESS');
  return { ordersSynced: orders.length };
}

export async function fullSync() {
  const startedAt = Date.now();
  const results = { productsSynced: 0, ordersSynced: 0, alertsCreated: 0, listingsReconciled: 0, errors: [] };

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

  // Auto-reconcile: after every sync, cap channel listings to warehouse
  // availability so no marketplace ever advertises more than we can ship.
  const rr = await safe('Listing Reconcile', reconcileChannelListings);
  if (rr) results.listingsReconciled = rr.adjusted;

  const hasErrors = results.errors.length > 0;
  await logActivity(
    'FULL_SYNC',
    hasErrors
      ? `Sync finished with ${results.errors.length} error(s).`
      : `Full sync complete: ${results.productsSynced} products, ${results.ordersSynced} orders, ${results.listingsReconciled} listings reconciled.`,
    hasErrors ? 'WARNING' : 'SUCCESS'
  );

  return {
    status: hasErrors ? 'PARTIAL' : 'SUCCESS',
    message: hasErrors
      ? `Synced ${results.productsSynced}p / ${results.ordersSynced}o. Errors: ${results.errors.join('; ')}`
      : `Synced ${results.productsSynced} products, ${results.ordersSynced} orders, ${results.alertsCreated} alerts, ${results.listingsReconciled} listings reconciled.`,
    productsSynced: results.productsSynced,
    ordersSynced: results.ordersSynced,
    alertsCreated: results.alertsCreated,
    listingsReconciled: results.listingsReconciled,
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
    { rows: [allocation] },
    { rows: recentLogs },
  ] = await Promise.all([
    query(`SELECT COUNT(*)::int AS total, COALESCE(SUM(price), 0)::float AS total_value,
           COALESCE(SUM(inventory), 0)::int AS total_inventory FROM products`),
    query(`SELECT COUNT(*)::int AS total, COALESCE(SUM(total), 0)::float AS total_revenue FROM orders`),
    query(`SELECT COUNT(*)::int AS total FROM inventory_alerts WHERE resolved = FALSE`),
    query(`SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE approved = TRUE)::int AS approved FROM descriptions`),
    query(`SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE status = 'SUCCESS')::int AS succeeded FROM scheduler_runs`),
    query(`SELECT
      COUNT(*) FILTER (WHERE allocation_status = 'ALLOCATED')::int AS allocated_orders,
      COUNT(*) FILTER (WHERE allocation_status = 'REJECTED')::int AS rejected_orders,
      (SELECT COALESCE(SUM(allocated_quantity), 0)::int FROM products) AS reserved_units
    FROM orders`),
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
    // Over-order guard KPIs
    allocatedOrders: allocation.allocated_orders,
    rejectedOrders: allocation.rejected_orders,
    reservedUnits: allocation.reserved_units,
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
      let sql = `SELECT o.*, (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = o.id)::int AS item_count FROM orders o`;
      const params = [];
      if (status) { params.push(status); sql += ` WHERE o.status = $1`; }
      sql += ' ORDER BY o.created_at DESC';
      const { rows } = await query(sql, params);
      return send(res, 200, rows.map(toApiOrder));
    }

    // GET /api/orders/:id — single order detail (with line items)
    const orderDetailMatch = path.match(/^\/api\/orders\/(\d+)$/);
    if (method === 'GET' && orderDetailMatch) {
      const { rows } = await query('SELECT * FROM orders WHERE id = $1', [orderDetailMatch[1]]);
      if (!rows.length) return send(res, 404, { message: 'Order not found' });
      const items = await getOrderItems(rows[0].id);
      return send(res, 200, { ...toApiOrder(rows[0]), items: items.map(toApiOrderItem) });
    }

    // POST /api/orders/intake — ingest an order from any channel through the over-order guard
    if (method === 'POST' && path === '/api/orders/intake') {
      const body = await parseBody(req);
      const channel = String(body.channel ?? '').toUpperCase();
      const items = Array.isArray(body.items) ? body.items : [];
      if (!channel || !items.length) {
        return send(res, 400, { message: 'channel and items are required' });
      }
      if (!['SHOPIFY', ...MOCK_CHANNEL_CODES].includes(channel)) {
        return send(res, 400, { message: `Unknown channel: ${channel}` });
      }
      try {
        const result = await placeChannelOrder({
          channelCode: channel,
          orderReference: body.orderReference ?? null,
          customerName: body.customerName ?? null,
          email: body.email ?? null,
          status: body.status ?? 'paid',
          total: Number(body.total ?? 0),
          items,
        });
        await logActivity(
          'ORDER_INTAKE',
          `Order #${result.orderId} via ${channel} → ${result.status}${result.shortfalls.length ? ` (${result.shortfalls.length} shortfall(s))` : ''}.`,
          result.status === 'ALLOCATED' ? 'SUCCESS' : 'WARNING'
        );
        return send(res, 200, result);
      } catch (err) {
        return send(res, 400, { message: err.message });
      }
    }

    // POST /api/orders/:id/release — cancel order and return reserved stock
    const orderReleaseMatch = path.match(/^\/api\/orders\/(\d+)\/release$/);
    if (method === 'POST' && orderReleaseMatch) {
      const result = await releaseOrderAllocation(orderReleaseMatch[1]);
      return send(res, result.status === 'NOT_FOUND' ? 404 : 200, result);
    }

    // POST /api/orders/:id/fulfill — ship order, deduct warehouse stock
    const orderFulfillMatch = path.match(/^\/api\/orders\/(\d+)\/fulfill$/);
    if (method === 'POST' && orderFulfillMatch) {
      const result = await fulfillOrderAllocation(orderFulfillMatch[1]);
      return send(res, result.status === 'NOT_FOUND' ? 404 : 200, result);
    }

    // POST /api/orders/check — non-mutating availability check for a basket
    if (method === 'POST' && path === '/api/orders/check') {
      const body = await parseBody(req);
      const items = Array.isArray(body.items)
        ? body.items
            .map((i) => ({ productId: Number(i.productId), quantity: Number(i.quantity) || 1 }))
            .filter((i) => Number.isFinite(i.productId))
        : [];
      if (!items.length) return send(res, 400, { message: 'items are required' });
      const result = await checkOrderFulfillable(items);
      return send(res, 200, result);
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

    // ── Description Pipeline ─────────────────────
    // Settings: brand voice
    if (method === 'GET' && path === '/api/descriptions/settings') {
      return send(res, 200, await getBrandVoiceSettings());
    }

    if (method === 'POST' && path === '/api/descriptions/settings') {
      const body = await parseBody(req);
      const validTones = ['professional', 'friendly', 'playful', 'expert'];
      if (body.tone && !validTones.includes(body.tone)) {
        return send(res, 400, {
          message: `Invalid tone "${body.tone}". Valid options: ${validTones.join(', ')}`,
        });
      }
      const settings = await updateBrandVoiceSettings(body);
      return send(res, 200, settings);
    }

    // Pipeline metrics
    if (method === 'GET' && path === '/api/descriptions/metrics') {
      return send(res, 200, await getDescriptionMetrics());
    }

    // List descriptions with status filter
    if (method === 'GET' && path === '/api/descriptions') {
      const statusFilter = url.searchParams.get('status') ?? '';
      const limit = Math.min(Number(url.searchParams.get('limit') ?? 200), 1000);
      let sql = `
        SELECT d.*, p.title as product_title, p.vendor
        FROM descriptions d JOIN products p ON p.id = d.product_id
      `;
      const params = [];
      if (statusFilter) {
        params.push(statusFilter);
        sql += ` WHERE d.description_status = $1`;
      }
      sql += ` ORDER BY d.generated_at DESC LIMIT ${limit}`;
      const { rows } = await query(sql, params);
      return send(res, 200, rows.map(toApiDescription));
    }

    // Legacy pending endpoint
    if (method === 'GET' && path === '/api/descriptions/pending') {
      const { rows } = await query(`
        SELECT d.*, p.title as product_title, p.vendor
        FROM descriptions d JOIN products p ON p.id = d.product_id
        WHERE d.approved = FALSE
        ORDER BY d.generated_at DESC
      `);
      return send(res, 200, rows.map(toApiDescription));
    }

    // Batch generation with enhanced metrics
    if (method === 'POST' && path === '/api/descriptions/batch-generate' ||
        method === 'POST' && path === '/api/descriptions/generate/batch') {
      const result = await generateMissingDescriptions();
      return send(res, 200, result);
    }

    // ── Product-specific description endpoints ────
    // GET /api/products/:id/description
    const productDescGetMatch = path.match(/^\/api\/products\/(\d+)\/description$/);
    if (method === 'GET' && productDescGetMatch) {
      const productId = productDescGetMatch[1];
      const { rows: productRows } = await query('SELECT * FROM products WHERE id = $1', [productId]);
      if (!productRows.length) return send(res, 404, { message: 'Product not found' });

      const { rows: descRows } = await query(`
        SELECT d.*, p.title as product_title, p.vendor
        FROM descriptions d JOIN products p ON p.id = d.product_id
        WHERE d.product_id = $1 ORDER BY d.generated_at DESC LIMIT 1
      `, [productId]);

      if (!descRows.length) {
        return send(res, 200, {
          productId: Number(productId),
          productTitle: productRows[0].title,
          hasDescription: false,
        });
      }
      return send(res, 200, toApiDescription(descRows[0]));
    }

    // POST /api/products/:id/description/approve
    const productDescApproveMatch = path.match(/^\/api\/products\/(\d+)\/description\/approve$/);
    if (method === 'POST' && productDescApproveMatch) {
      const productId = productDescApproveMatch[1];
      const body = await parseBody(req);

      const { rows: productRows } = await query('SELECT * FROM products WHERE id = $1', [productId]);
      if (!productRows.length) return send(res, 404, { message: 'Product not found' });

      const { rows: descRows } = await query(`
        SELECT * FROM descriptions WHERE product_id = $1 ORDER BY generated_at DESC LIMIT 1
      `, [productId]);

      if (!descRows.length) {
        return send(res, 404, { message: 'No generated description found for this product' });
      }

      const finalText = body.editedText || descRows[0].generated_description;
      const reviewNotes = body.reviewNotes || null;

      await query(`
        UPDATE descriptions SET
          description_status = 'approved',
          generated_description = $1,
          review_notes = $2,
          approved = TRUE
        WHERE id = $3
      `, [finalText, reviewNotes, descRows[0].id]);

      // Also update the product's description field
      await query(
        `UPDATE products SET description = $1, updated_at = NOW() WHERE id = $2`,
        [finalText, productId]
      );

      await logActivity(
        'DESCRIPTION_APPROVED',
        `Description approved for product #${productId} "${productRows[0].title}".`,
        'SUCCESS'
      );

      return send(res, 200, {
        status: 'APPROVED',
        descriptionId: Number(descRows[0].id),
        productId: Number(productId),
        approvedAt: new Date().toISOString(),
      });
    }

    // POST /api/products/:id/description/publish (placeholder)
    const productDescPublishMatch = path.match(/^\/api\/products\/(\d+)\/description\/publish$/);
    if (method === 'POST' && productDescPublishMatch) {
      const productId = productDescPublishMatch[1];

      const { rows: productRows } = await query('SELECT * FROM products WHERE id = $1', [productId]);
      if (!productRows.length) return send(res, 404, { message: 'Product not found' });

      const { rows: descRows } = await query(`
        SELECT * FROM descriptions WHERE product_id = $1 AND description_status = 'approved' ORDER BY generated_at DESC LIMIT 1
      `, [productId]);

      if (!descRows.length) {
        return send(res, 400, { message: 'No approved description to publish. Approve first.' });
      }

      // Placeholder: In the future, push to Shopify here
      await query(`
        UPDATE descriptions SET description_status = 'published' WHERE id = $1
      `, [descRows[0].id]);

      await logActivity(
        'DESCRIPTION_PUBLISHED',
        `Description published for product #${productId} "${productRows[0].title}". (Placeholder — Shopify push not yet implemented)`,
        'INFO'
      );

      return send(res, 200, {
        status: 'PUBLISHED',
        descriptionId: Number(descRows[0].id),
        productId: Number(productId),
        message: 'Description marked as published. Shopify push is a placeholder — implement later.',
        publishedAt: new Date().toISOString(),
      });
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

    // ── Multi-Channel Inventory ──────────────────
    // GET /api/inventory/unified — unified view across all channels
    if (method === 'GET' && path === '/api/inventory/unified') {
      return send(res, 200, await getUnifiedInventory());
    }

    // GET /api/mock-channels/:channel/inventory — raw channel inventory
    const mockChannelGetMatch = path.match(/^\/api\/mock-channels\/(amazon_mock|myntra_mock|flipkart_mock)\/inventory$/i);
    if (method === 'GET' && mockChannelGetMatch) {
      const channelCode = mockChannelGetMatch[1].toUpperCase();
      const data = getMockInventory(channelCode);
      return send(res, 200, { channel: channelCode, products: data });
    }

    // POST /api/mock-channels/:channel/orders — place a customer order on a mock marketplace
    const mockChannelOrderMatch = path.match(/^\/api\/mock-channels\/(amazon_mock|myntra_mock|flipkart_mock)\/orders$/i);
    if (method === 'POST' && mockChannelOrderMatch) {
      const channelCode = mockChannelOrderMatch[1].toUpperCase();
      const body = await parseBody(req);
      const items = Array.isArray(body.items) ? body.items : [];
      if (!items.length) {
        return send(res, 400, { message: 'items are required' });
      }
      try {
        const result = await placeChannelOrder({
          channelCode,
          orderReference: body.orderReference ?? `${channelCode}-${Date.now()}`,
          customerName: body.customerName ?? 'Test Shopper',
          email: body.email ?? null,
          status: body.status ?? 'paid',
          total: Number(body.total ?? 0),
          items,
        });
        await logActivity(
          'ORDER_INTAKE',
          `Order #${result.orderId} placed on ${channelCode} → ${result.status}${result.shortfalls.length ? ` (${result.shortfalls.length} shortfall(s))` : ''}.`,
          result.status === 'ALLOCATED' ? 'SUCCESS' : 'WARNING'
        );
        return send(res, result.status === 'ALLOCATED' ? 200 : 409, result);
      } catch (err) {
        return send(res, 400, { message: err.message });
      }
    }

    // POST /api/inventory/reconcile — cap channel listings to warehouse availability
    if (method === 'POST' && path === '/api/inventory/reconcile') {
      const result = await reconcileChannelListings();
      await logActivity(
        'LISTING_RECONCILE',
        `Reconciled ${result.adjusted} channel listing(s) to warehouse availability.`,
        result.adjusted ? 'INFO' : 'SUCCESS'
      );
      return send(res, 200, result);
    }

    // GET /api/inventory/safety-buffer — current sellable % of warehouse stock
    if (method === 'GET' && path === '/api/inventory/safety-buffer') {
      return send(res, 200, { bufferPercent: await getSafetyBufferPercent() });
    }

    // PUT /api/inventory/safety-buffer — update the over-order guard buffer
    if (method === 'PUT' && path === '/api/inventory/safety-buffer') {
      const body = await parseBody(req);
      const pct = Number(body.bufferPercent);
      if (!Number.isFinite(pct) || pct < 1 || pct > 100) {
        return send(res, 400, { message: 'bufferPercent must be between 1 and 100' });
      }
      return send(res, 200, await updateSafetyBufferPercent(pct));
    }

    // POST /api/mock-channels/:channel/quantity — update mock channel qty by product ID
    const mockChannelQtyMatch = path.match(/^\/api\/mock-channels\/(amazon_mock|myntra_mock|flipkart_mock)\/quantity$/i);
    if (method === 'POST' && mockChannelQtyMatch) {
      const channelCode = mockChannelQtyMatch[1].toUpperCase();
      const body = await parseBody(req);
      const productId = Number(body.productId);
      const qty = Number(body.quantity);
      if (!productId || !Number.isFinite(qty)) {
        return send(res, 400, { message: 'productId and quantity are required' });
      }

      // 1) Try updating the in-memory mock store (may not have the product yet)
      const result = updateMockQuantityByProductId(channelCode, productId, qty);

      // 2) Always update the DB — this is the source of truth for the unified view
      const dbResult = await updateChannelProductQuantity(channelCode, productId, qty);

      // 3) If not found in either, seed the mock store from DB and try once more
      if (!result.success && !dbResult) {
        // Refresh mock store from DB
        try {
          const { fetchMockChannelSeedData } = await import('./database.js');
          const rows = await fetchMockChannelSeedData();
          if (rows.length > 0) {
            const seedData = {};
            for (const row of rows) {
              const chCode = row.channel_code;
              if (!seedData[chCode]) seedData[chCode] = [];
              seedData[chCode].push({
                channelSku: row.channel_sku,
                externalId: row.external_id,
                title: row.title,
                availableQuantity: Number(row.available_quantity),
                internalProductId: Number(row.product_id),
              });
            }
            initializeMockData(seedData);
          }
        } catch { /* ignore re-seed errors */ }

        return send(res, 404, {
          message: `Product #${productId} has no listing on ${channelCode}. Sync the channel first.`,
          channel: channelCode,
          productId,
        });
      }

      const updatedItem = result.success ? result.item : { availableQuantity: qty, channelSku: dbResult?.channelSku || '' };
      return send(res, 200, { channel: channelCode, updated: true, item: updatedItem });
    }

    // POST /api/inventory/sync/:channel — sync a mock channel into unified DB
    const syncChannelMatch = path.match(/^\/api\/inventory\/sync\/(amazon-mock|myntra-mock|flipkart-mock)$/i);
    if (method === 'POST' && syncChannelMatch) {
      const channelCode = syncChannelMatch[1].toUpperCase().replace('-', '_');
      const connector = channelConnectors[channelCode];
      if (!connector) {
        return send(res, 400, { message: `Unknown channel: ${channelCode}` });
      }
      const result = await syncMockChannel(channelCode, connector);
      return send(res, 200, {
        channel: channelCode,
        status: result.errors.length === 0 ? 'SUCCESS' : 'PARTIAL',
        synced: result.synced,
        updated: result.updated,
        errors: result.errors,
      });
    }

    // POST /api/inventory/sync-all — sync all mock channels
    if (method === 'POST' && path === '/api/inventory/sync-all') {
      const results = {};
      for (const code of MOCK_CHANNEL_CODES) {
        try {
          const conn = channelConnectors[code];
          if (conn) {
            results[code] = await syncMockChannel(code, conn);
          }
        } catch (err) {
          results[code] = { synced: 0, updated: 0, errors: [err.message] };
        }
      }
      return send(res, 200, { syncedChannels: Object.keys(results), details: results });
    }

    // POST /api/inventory/warehouse/:id — update warehouse quantity
    const warehouseMatch = path.match(/^\/api\/inventory\/warehouse\/(\d+)$/);
    if (method === 'POST' && warehouseMatch) {
      const body = await parseBody(req);
      const qty = Number(body.quantity);
      if (!Number.isFinite(qty)) {
        return send(res, 400, { message: 'quantity is required' });
      }
      const result = await updateWarehouseQuantity(warehouseMatch[1], qty);
      if (!result) {
        return send(res, 404, { message: 'Product not found' });
      }
      return send(res, 200, result);
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

    // ── Test Email Endpoints (Sandbox / Dev only) ──
    if (method === 'POST' && path === '/api/test-email/order') {
      const body = await parseBody(req);

      // Build a mock order object from request or use defaults
      const mockOrder = {
        shopify_order_id: body.orderId || '12345',
        customer_name: body.customerName || 'Test Customer',
        email: body.email || 'test@example.com',
        status: body.status || 'paid',
        total: body.total || 99.99,
      };

      try {
        const result = await sendOrderNotification(mockOrder);
        await logActivity(
          'TEST_EMAIL_ORDER',
          `Test order email sent to ${mockOrder.email} (order #${mockOrder.shopify_order_id}). mock=${result.mock}`,
          result.sent ? 'SUCCESS' : 'ERROR'
        );
        return send(res, 200, {
          type: 'order',
          sent: result.sent,
          mock: result.mock,
          messageId: result.messageId,
          recipient: mockOrder.email,
          orderId: mockOrder.shopify_order_id,
          customerName: mockOrder.customer_name,
          status: mockOrder.status,
          total: mockOrder.total,
        });
      } catch (err) {
        return send(res, 500, { type: 'order', sent: false, error: err.message });
      }
    }

    if (method === 'POST' && path === '/api/test-email/low-stock') {
      const body = await parseBody(req);

      // Build a mock product / alert from request or use defaults
      const mockProduct = {
        id: body.productId || 1,
        title: body.productTitle || 'Test Product',
        sku: body.sku || 'SKU-TEST-001',
      };
      const mockQty = body.quantity != null ? body.quantity : 3;
      const mockThreshold = body.threshold || 5;
      const recipient = body.email || 'admin@wesee-autopilot.com';

      try {
        const result = await sendLowStockAlert(mockProduct, mockQty, mockThreshold, recipient);
        await logActivity(
          'TEST_EMAIL_LOW_STOCK',
          `Test low-stock alert sent to ${recipient} for "${mockProduct.title}" (qty: ${mockQty}). mock=${result.mock}`,
          result.sent ? 'SUCCESS' : 'ERROR'
        );
        return send(res, 200, {
          type: 'low-stock',
          sent: result.sent,
          mock: result.mock,
          messageId: result.messageId,
          recipient,
          productTitle: mockProduct.title,
          sku: mockProduct.sku,
          quantity: mockQty,
          threshold: mockThreshold,
        });
      } catch (err) {
        return send(res, 500, { type: 'low-stock', sent: false, error: err.message });
      }
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
  const recoveredRuns = await markOrphanedSchedulerRunsFailed();
  if (recoveredRuns > 0) {
    console.log(`[Startup] Recovered ${recoveredRuns} orphaned scheduler run(s) left RUNNING by a previous process restart.`);
  }

  // Seed the in-memory mock data store from DB
  try {
    const rows = await fetchMockChannelSeedData();
    if (rows.length > 0) {
      const seedData = {};
      for (const row of rows) {
        const chCode = row.channel_code;
        if (!seedData[chCode]) seedData[chCode] = [];
        seedData[chCode].push({
          channelSku: row.channel_sku,
          externalId: row.external_id,
          title: row.title,
          availableQuantity: Number(row.available_quantity),
          internalProductId: Number(row.product_id),
        });
      }
      initializeMockData(seedData);
      console.log(`[MockData] Initialized ${Object.keys(seedData).length} channel(s) with ${rows.length} total product records.`);
    } else {
      console.log('[MockData] No channel products found — skipping mock store seed');
    }
  } catch (err) {
    console.error('[MockData] Failed to seed:', err.message);
  }

  // The cron engine normally lives in this process. When the API and the
  // scheduler are deployed as separate services (Render web service + worker),
  // the web service sets AUTOPILOT_DISABLE_SCHEDULER=1 so jobs never run twice
  // (which would cause duplicate emails and doubled Gemini calls) — only the
  // dedicated worker service runs them.
  if (process.env.AUTOPILOT_DISABLE_SCHEDULER === '1') {
    console.log('[Web] Scheduler disabled (AUTOPILOT_DISABLE_SCHEDULER=1) — cron runs on the dedicated worker service.');
  } else {
    startScheduler({ fullSync, auditInventory, sendOrderNotifications, generateMissingDescriptions, reconcileChannelListings, logActivity });
  }

  // Scheduler-only mode — used by the separate Render Background Worker so the
  // cron engine runs as its own process (no HTTP server, no public URL).
  if (process.env.AUTOPILOT_SCHEDULER_ONLY === '1') {
    console.log('[Worker] Scheduler-only mode — HTTP server not started. All 6 cron jobs are active.');
    return;
  }

  server.listen(port, () => {
    console.log(`\n🚀 E-Commerce Autopilot Backend`);
    console.log(`   Listening: http://localhost:${port}`);
    console.log(`   Health:    http://localhost:${port}/actuator/health`);
    console.log(`   KPIs:      http://localhost:${port}/api/kpis\n`);
  });
}

async function shutdownGracefully(signal) {
  console.log(`\nShutting down gracefully (${signal})...`);
  if (server.listening) server.close();
  await closeDatabase();
  process.exit(0);
}

process.on('SIGINT', () => shutdownGracefully('SIGINT'));
// Render sends SIGTERM when an instance is stopped/restarted — without this the
// scheduler_runs rows would be left RUNNING and marked failed on next boot.
process.on('SIGTERM', () => shutdownGracefully('SIGTERM'));

// Only auto-start when run directly (not imported by tests or other modules)
if (!process.env.AUTOPILOT_SKIP_START) {
  start().catch((error) => {
    console.error('Failed to start backend:', error);
    process.exit(1);
  });
}
