import { query, withTransaction } from './database.js';
import { buildDescriptionPrompt, generateWithGemini } from './gemini.js';
import { sendOrderNotification, sendLowStockAlert } from './email/index.js';

// ──────────────────────────────────────────────
// Notification retry configuration (Phase 2: restart-safe retries)
// ──────────────────────────────────────────────
export const NOTIFICATION_MAX_RETRIES = Math.max(1, Number(process.env.NOTIFICATION_MAX_RETRIES ?? 5));
const NOTIFICATION_RETRY_BASE_MS = Math.max(250, Number(process.env.NOTIFICATION_RETRY_BASE_MS ?? 30_000));
const NOTIFICATION_RETRY_MAX_MS = Math.max(NOTIFICATION_RETRY_BASE_MS, Number(process.env.NOTIFICATION_RETRY_MAX_MS ?? 15 * 60_000));
const NOTIFICATION_BATCH_LIMIT = Math.max(1, Number(process.env.NOTIFICATION_BATCH_LIMIT ?? 50));

/** Exposed for tests/ops tooling. */
export function getNotificationRetryConfig() {
  return { maxRetries: NOTIFICATION_MAX_RETRIES, baseMs: NOTIFICATION_RETRY_BASE_MS, maxMs: NOTIFICATION_RETRY_MAX_MS, batchLimit: NOTIFICATION_BATCH_LIMIT };
}

/** Bounded exponential backoff with ±20% jitter. */
export function notificationBackoffMs(retryCount) {
  const exponential = NOTIFICATION_RETRY_BASE_MS * 2 ** Math.max(0, retryCount - 1);
  const jitter = exponential * 0.2 * (Math.random() * 2 - 1);
  return Math.min(NOTIFICATION_RETRY_MAX_MS, Math.max(0, Math.round(exponential + jitter)));
}

export function shopifyBaseUrl(shopName, apiVersion = '2024-04') {
  if (!shopName?.trim()) throw new Error('SHOPIFY_SHOP_NAME is not configured');
  const domain = shopName.trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const host = domain.includes('.') ? domain : `${domain.toLowerCase().replace(/\s+/g, '-')}.myshopify.com`;
  return `https://${host}/admin/api/${apiVersion}`;
}

export function productFromShopify(product) {
  const variants = product.variants ?? [];
  const firstVariant = variants[0];
  return {
    shopifyProductId: Number(product.id),
    title: product.title ?? 'Untitled product',
    description: product.body_html ?? null,
    vendor: product.vendor ?? null,
    status: product.status ?? null,
    price: Number(firstVariant?.price ?? 0),
    inventory: variants.reduce((total, v) => total + Number(v.inventory_quantity ?? 0), 0),
    // Shopify product payloads carry the main image on `image.src` and the
    // full gallery under `images[].src` — capture whichever is available.
    imageUrl: product.image?.src ?? product.images?.[0]?.src ?? null,
  };
}

export function toApiProduct(row) {
  return {
    id: Number(row.id),
    shopifyProductId: Number(row.shopify_product_id),
    title: row.title,
    description: row.description,
    vendor: row.vendor,
    status: row.status,
    inventory: Number(row.inventory),
    price: Number(row.price),
    imageUrl: row.image_url ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function orderFromShopify(shopifyOrder) {
  return {
    shopifyOrderId: Number(shopifyOrder.id),
    customerName: shopifyOrder.customer
      ? `${shopifyOrder.customer.first_name ?? ''} ${shopifyOrder.customer.last_name ?? ''}`.trim() || null
      : null,
    email: shopifyOrder.email ?? null,
    status: shopifyOrder.financial_status ?? 'pending',
    total: Number(shopifyOrder.total_price ?? 0),
    createdAt: shopifyOrder.created_at,
  };
}

export function toApiOrder(row) {
  return {
    id: Number(row.id),
    shopifyOrderId: row.shopify_order_id != null ? Number(row.shopify_order_id) : null,
    channelCode: row.channel_code ?? 'SHOPIFY',
    orderReference: row.order_reference ?? null,
    allocationStatus: row.allocation_status ?? 'UNCHECKED',
    allocationNotes: row.allocation_notes ?? null,
    itemCount: row.item_count != null ? Number(row.item_count) : null,
    customerName: row.customer_name,
    email: row.email,
    status: row.status,
    total: Number(row.total),
    notificationStatus: row.notification_status ?? 'UNNOTIFIED',
    createdAt: row.created_at,
  };
}

export function toApiOrderItem(row) {
  return {
    id: Number(row.id),
    productId: Number(row.product_id),
    channelSku: row.channel_sku ?? null,
    quantity: Number(row.quantity),
    productTitle: row.product_title ?? null,
    productSku: row.product_sku ?? null,
  };
}

export function toApiInventoryAlert(row) {
  return {
    id: Number(row.id),
    productId: Number(row.product_id),
    productTitle: row.product_title ?? null,
    shopifyProductId: row.shopify_product_id ? Number(row.shopify_product_id) : null,
    currentStock: Number(row.current_stock),
    threshold: Number(row.threshold),
    resolved: Boolean(row.resolved),
    createdAt: row.created_at,
  };
}

export function toApiActivityLog(row) {
  return {
    id: Number(row.id),
    type: row.type,
    message: row.message,
    status: row.status,
    createdAt: row.created_at,
  };
}

export function toApiSchedulerRun(row) {
  return {
    id: Number(row.id),
    jobName: row.job_name,
    started: row.started,
    finished: row.finished ?? null,
    status: row.status,
    durationMs: row.duration ?? null,
    errorMessage: row.error_message ?? null,
  };
}

export function toApiDescriptionMetrics(row) {
  return {
    totalDescriptions: Number(row.total_descriptions),
    pendingCount: Number(row.pending_count),
    generatedCount: Number(row.generated_count),
    approvedCount: Number(row.approved_count),
    publishedCount: Number(row.published_count),
    productsWithoutDesc: Number(row.products_without_desc),
    lastBatchRun: row.last_batch_run ?? null,
    totalBatchRuns: Number(row.total_batch_runs),
    totalProductsProcessed: Number(row.total_products_processed),
  };
}

export function toApiDescription(row) {
  return {
    id: Number(row.id),
    productId: Number(row.product_id),
    productTitle: row.product_title ?? null,
    vendor: row.vendor ?? null,
    generatedDescription: row.generated_description,
    descriptionStatus: row.description_status ?? (row.approved ? 'approved' : 'generated'),
    approved: Boolean(row.approved),
    reviewNotes: row.review_notes ?? null,
    generatedAt: row.generated_at,
  };
}

export function toApiDescriptionSettings(row) {
  return {
    id: Number(row.id),
    tone: row.tone,
    language: row.language,
    brandPhrases: row.brand_phrases ?? '',
    styleNotes: row.style_notes ?? '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ──────────────────────────────────────────────
// Service / domain functions (no HTTP side effects)
// ──────────────────────────────────────────────

export async function logActivity(type, message, status = 'INFO') {
  try {
    await query(
      `INSERT INTO activity_logs (type, message, status) VALUES ($1, $2, $3)`,
      [type, message, status]
    );
  } catch (err) {
    console.error('[ActivityLog] Failed to write log:', err.message);
  }
}

export async function auditInventory() {
  const { rows: lowStock } = await query(
    `SELECT id, title, sku, inventory FROM products WHERE inventory <= 5 AND inventory >= 0`
  );
  let alertsCreated = 0;
  for (const product of lowStock) {
    const { rows: existing } = await query(
      'SELECT id FROM inventory_alerts WHERE product_id = $1 AND resolved = FALSE',
      [product.id]
    );
    if (existing.length === 0) {
      await query(
        'INSERT INTO inventory_alerts (product_id, current_stock, threshold) VALUES ($1, $2, 5)',
        [product.id, product.inventory]
      );
      alertsCreated += 1;
      await logActivity(
        'LOW_STOCK_ALERT',
        `Low stock: "${product.title}" — ${product.inventory} remaining (threshold: 5).`,
        'WARNING'
      );

      // ── Send low-stock alert email via Mailtrap (best-effort) ──────────
      try {
        await sendLowStockAlert(product, product.inventory, 5);
        await logActivity(
          'LOW_STOCK_EMAIL',
          `Low-stock alert emailed for "${product.title}" (qty: ${product.inventory}).`,
          'SUCCESS'
        );
      } catch (emailErr) {
        console.error(`[auditInventory] Failed to send low-stock email for "${product.title}":`, emailErr.message);
        // Non-blocking: don't fail the audit because email failed
      }
    }
  }
  return { alertsCreated, lowStockCount: lowStock.length };
}

/**
 * Get the current brand voice settings from the DB.
 * Returns the default settings if none are configured.
 */
export async function getBrandVoiceSettings() {
  const { rows } = await query('SELECT * FROM description_settings ORDER BY id DESC LIMIT 1');
  if (rows.length === 0) {
    return { id: null, tone: '', language: '', brandPhrases: '', styleNotes: '' };
  }
  return toApiDescriptionSettings(rows[0]);
}

/**
 * Update brand voice settings (inserts a new row, keeps full history).
 */
export async function updateBrandVoiceSettings(settings) {
  const { rows } = await query(`
    INSERT INTO description_settings (tone, language, brand_phrases, style_notes, updated_at)
    VALUES ($1, $2, $3, $4, NOW())
    RETURNING *
  `, [
    settings.tone ?? '',
    settings.language ?? '',
    settings.brandPhrases ?? '',
    settings.styleNotes ?? '',
  ]);

  await logActivity(
    'BRAND_VOICE_UPDATED',
    `Brand voice updated: tone="${settings.tone}", language="${settings.language}"`,
    'INFO'
  );

  return toApiDescriptionSettings(rows[0]);
}export async function generateSingleDescription(product, options = {}) {
  /** @type {'mock' | 'gemini' | null} */
  const mode = (() => {
    const key = process.env.GEMINI_API_KEY;
    if (!key || key.startsWith('placeholder')) return 'mock';
    return 'gemini';
  })();

  // Load brand voice if not already passed
  if (!options.brandVoice) {
    const settings = await getBrandVoiceSettings();
    options.brandVoice = {
      tone: settings.tone,
      language: settings.language,
      brand_phrases: settings.brandPhrases,
      style_notes: settings.styleNotes,
    };
  }
  // If tone is explicitly passed, it overrides brand voice tone
  if (options.tone && !options.brandVoice) {
    options.brandVoice = await getBrandVoiceSettings();
  }

  // Phase 2 invariant: APPROVED/PUBLISHED CONTENT MUST NOT BE LOST.
  // Regeneration is refused while an approved description exists — the caller
  // (route) decides what to tell the client; lib returns null here.
  if (options.allowOverwriteApproved !== true) {
    const { rows: approved } = await query(
      `SELECT id FROM descriptions
       WHERE product_id = $1 AND (approved = TRUE OR description_status IN ('approved', 'published'))
       LIMIT 1`,
      [product.id]
    );
    if (approved.length) {
      await logActivity(
        'AI_GENERATION',
        `Refused regeneration for "${product.title}": an approved/published description already exists.`,
        'INFO'
      );
      return null;
    }
  }

  if (mode === 'mock') {
    const prompt = buildDescriptionPrompt(product, options);
    const promptLength = prompt.length;

    // Mock description for development
    const mockDesc = `Introducing ${product.title} — a premium product from ${product.vendor || 'our collection'}. Crafted with attention to detail, this item delivers exceptional quality and performance that discerning customers demand. Whether for personal use or as a thoughtful gift, it stands out from the rest.\n\nKey highlights:\n• Superior build quality and lasting durability\n• Designed for everyday reliability and ease of use\n• Backed by our commitment to customer satisfaction\n\nAdd ${product.title} to your cart today and experience the difference quality makes. Limited stock available — order now and enjoy fast, reliable shipping.`;

    const { rows: inserted } = await query(`
      INSERT INTO descriptions (product_id, generated_description, description_status, generated_at)
      VALUES ($1, $2, 'generated', NOW())
      ON CONFLICT DO NOTHING
      RETURNING *
    `, [product.id, mockDesc]);

    if (inserted.length) {
      await logActivity(
        'AI_GENERATION',
        `Generated description for "${product.title}" (mock mode). prompt_len=${promptLength} gen_len=${mockDesc.length}`,
        'SUCCESS'
      );
    }
    return inserted.length ? { ...inserted[0], product_title: product.title } : null;
  }

  // Real Gemini call
  const prompt = buildDescriptionPrompt(product, options);
  const promptLength = prompt.length;

  const generatedText = await generateWithGemini(prompt);
  const generatedLength = generatedText.length;

  const { rows: inserted } = await query(`
    INSERT INTO descriptions (product_id, generated_description, description_status, generated_at)
    VALUES ($1, $2, 'generated', NOW())
    ON CONFLICT DO NOTHING
    RETURNING *
  `, [product.id, generatedText]);

  await logActivity(
    'AI_GENERATION',
    `Generated AI description for "${product.title}". prompt_len=${promptLength} gen_len=${generatedLength} model=${process.env.GEMINI_MODEL_NAME || 'gemini-1.5-flash'}`,
    'SUCCESS'
  );

  return { ...inserted[0], product_title: product.title };
}

/**
 * Order notification engine — restart-safe with persistent retry state (Phase 2).
 *
 * States (orders.notification_status):
 *   UNNOTIFIED  — waiting for the first send attempt
 *   PROCESSING  — atomically claimed by a worker (row-locked); crashed workers
 *                 are auto-recovered to UNNOTIFIED after a stale timeout
 *   NOTIFIED    — email sent (notification_sent_at stamped)
 *   RETRYING    — transient failure; notification_next_retry holds the due time
 *   FAILED      — permanent failure OR retry budget exhausted (a missing email
 *                 address is also permanent — there is nothing to retry against)
 *
 * Concurrency: claiming uses SELECT … FOR UPDATE SKIP LOCKED inside a
 * transaction, so two scheduler executions can never claim the same order and
 * duplicate emails are impossible. All state lives in the orders table, so
 * retries survive restarts, and due RETRYING rows are re-claimed by the
 * worker query.
 */

// A PROCESSING claim older than this is considered crashed and re-claimable.
const PROCESSING_STALE_MS = Math.max(30_000, Number(process.env.NOTIFICATION_PROCESSING_STALE_MS ?? 5 * 60_000));

/**
 * Atomically claim due notification work.
 * Claims UNNOTIFIED rows (immediately) and RETRYING rows whose
 * notification_next_retry has passed. Expired PROCESSING rows (crashed
 * worker) are recovered to UNNOTIFIED first in the same transaction.
 */
async function claimNotificationBatch(limit, now = new Date()) {
  return withTransaction(async (client) => {
    // 1) Recover orders stuck in PROCESSING from a crashed worker.
    await client.query(
      `UPDATE orders SET notification_status = 'UNNOTIFIED'
       WHERE notification_status = 'PROCESSING'
         AND notification_last_attempt < NOW() - make_interval(secs => $1 / 1000.0)`,
      [PROCESSING_STALE_MS]
    );

    // 2) Claim due work with row locks that don't block other workers.
    const { rows } = await client.query(
      `UPDATE orders SET notification_status = 'PROCESSING', notification_last_attempt = $2
       WHERE id IN (
         SELECT id FROM orders
         WHERE (
           (notification_status = 'UNNOTIFIED')
           OR (notification_status = 'RETRYING' AND notification_next_retry <= $2)
         )
           AND notification_retries < $3
           AND allocation_status IS DISTINCT FROM 'REJECTED'
         ORDER BY created_at ASC
         LIMIT $1
         FOR UPDATE SKIP LOCKED
       )
       RETURNING *`,
      [limit, now, NOTIFICATION_MAX_RETRIES]
    );
    return rows;
  });
}

export async function sendOrderNotifications({ sender = sendOrderNotification } = {}) {
  // The claim query already excludes REJECTED orders — we never send "order
  // confirmed" for an order the over-order guard refused.
  // `sender` is injectable for tests (defaults to the real email service).
  const unnotified = await claimNotificationBatch(NOTIFICATION_BATCH_LIMIT);

  if (!unnotified.length) {
    return { sent: 0, failed: 0, retried: 0, total: 0 };
  }

  let sent = 0;
  let failed = 0;
  let retried = 0;

  for (const order of unnotified) {
    // No email address is a PERMANENT failure — nothing to retry against.
    if (!order.email) {
      await query(
        `UPDATE orders SET
           notification_status = 'FAILED',
           notification_retries = notification_retries + 1,
           notification_last_attempt = NOW(),
           notification_last_error = 'no email address on order'
         WHERE id = $1`,
        [order.id]
      );
      failed += 1;
      await logActivity(
        'ORDER_NOTIFICATION',
        `Skipped order #${order.shopify_order_id}: no email address.`,
        'WARNING'
      );
      continue;
    }

    try {
      // Use the Mailtrap email service — falls back to mock if SMTP credentials are missing
      await sender(order);

      // Success: mark as notified (idempotent)
      await query(
        `UPDATE orders SET
           notification_status = 'NOTIFIED',
           notification_retries = notification_retries + 1,
           notification_last_attempt = NOW(),
           notification_sent_at = COALESCE(notification_sent_at, NOW()),
           notification_last_error = NULL,
           notification_next_retry = NULL
         WHERE id = $1`,
        [order.id]
      );
      sent += 1;
      await logActivity(
        'ORDER_NOTIFICATION',
        `Notification sent for order #${order.shopify_order_id} to ${order.email}.`,
        'SUCCESS'
      );
    } catch (err) {
      const newRetries = (order.notification_retries || 0) + 1;
      const exhausted = newRetries >= NOTIFICATION_MAX_RETRIES;
      const backoffMs = notificationBackoffMs(newRetries);

      await query(
        `UPDATE orders SET
           notification_status = $2,
           notification_retries = $3,
           notification_last_attempt = NOW(),
           notification_last_error = $4,
           notification_next_retry = CASE WHEN $2 = 'RETRYING' THEN NOW() + make_interval(secs => $5 / 1000.0) ELSE notification_next_retry END
         WHERE id = $1`,
        [order.id, exhausted ? 'FAILED' : 'RETRYING', newRetries, String(err.message ?? 'unknown error').slice(0, 500), backoffMs]
      );
      if (exhausted) failed += 1; else retried += 1;
      await logActivity(
        'ORDER_NOTIFICATION',
        `Failed to notify order #${order.shopify_order_id} (attempt ${newRetries}/${NOTIFICATION_MAX_RETRIES})${exhausted ? ' — retries exhausted' : `, retrying in ${Math.round(backoffMs / 1000)}s`}.`,
        exhausted ? 'ERROR' : 'WARNING'
      );
    }
  }

  return { sent, failed, retried, total: unnotified.length };
}

/**
 * Enhanced batch generation with pipeline metrics and detailed logging.
 *
 * Selects products that need descriptions (no generated description yet)
 * and runs them through the AI pipeline using current brand voice settings.
 */
export async function generateMissingDescriptions() {
  const { rows: products } = await query(`
    SELECT p.* FROM products p
    LEFT JOIN descriptions d ON d.product_id = p.id
    WHERE d.id IS NULL
  `);

  const startedAt = Date.now();

  if (!products.length) {
    await logActivity('AI_GENERATION_BATCH', 'No products missing descriptions.', 'INFO');
    return { generated: 0, skipped: 0, total: 0, errors: [], durationMs: 0 };
  }

  // Load brand voice settings once for the whole batch
  const settings = await getBrandVoiceSettings();
  const brandVoice = {
    tone: settings.tone,
    language: settings.language,
    brand_phrases: settings.brandPhrases,
    style_notes: settings.styleNotes,
  };

  // Phase 2: bounded concurrency — never fire unlimited Gemini requests.
  // The existing per-request rate-limit gate in gemini.js is preserved.
  const maxConcurrency = Math.max(1, Math.min(10, Number(process.env.AI_MAX_CONCURRENCY ?? 3) || 3));

  let generated = 0;
  let skipped = 0;
  const errors = [];
  let rateLimited = false;
  let cursor = 0;

  async function worker() {
    while (true) {
      if (rateLimited) return;
      const index = cursor++;
      if (index >= products.length) return;
      const product = products[index];
      try {
        const result = await generateSingleDescription(product, { brandVoice });
        if (result) {
          generated += 1;
        } else {
          skipped += 1;
        }
      } catch (err) {
        errors.push({ productId: product.id, title: product.title, error: err.message });
        console.error(`[DescriptionGen] Failed for "${product.title}":`, err.message);

        if (err?.code === 'GEMINI_RATE_LIMITED') {
          rateLimited = true;
          const remaining = products.length - errors.length - generated - skipped;
          await logActivity(
            'AI_GENERATION_BATCH',
            `Paused after Gemini rate limit while processing "${product.title}". ${Math.max(0, remaining)} product(s) deferred to the next run.`,
            'WARNING'
          );
          return;
        }
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(maxConcurrency, products.length) }, worker));

  const durationMs = Date.now() - startedAt;

  await logActivity(
    'AI_GENERATION_BATCH',
    `Batch complete: ${generated}/${products.length} generated, ${skipped} skipped, ${errors.length} error(s) in ${durationMs}ms.`,
    errors.length ? 'WARNING' : 'SUCCESS'
  );

  return { generated, skipped, total: products.length, errors, durationMs };
}

/**
 * Get pipeline metrics: counts per status, batch run stats.
 *
 * Phase 2: the batch-run block no longer scans the entire activity_logs table
 * with a correlated per-row subquery. It aggregates ONLY AI_GENERATION_BATCH
 * rows (partial index idx_logs_type_batch), and products-processed is derived
 * from a single indexed COUNT on descriptions instead of a window scan.
 */
export async function getDescriptionMetrics() {
  const { rows: [stats] } = await query(`
    SELECT
      COUNT(*)::int AS total_descriptions,
      COUNT(*) FILTER (WHERE description_status = 'pending')::int AS pending_count,
      COUNT(*) FILTER (WHERE description_status = 'generated')::int AS generated_count,
      COUNT(*) FILTER (WHERE description_status = 'approved')::int AS approved_count,
      COUNT(*) FILTER (WHERE description_status = 'published')::int AS published_count,
      (SELECT COUNT(*)::int FROM products p
       LEFT JOIN descriptions d ON d.product_id = p.id
       WHERE d.id IS NULL) AS products_without_desc
    FROM descriptions
  `);

  const { rows: [batchInfo] } = await query(`
    SELECT
      MAX(created_at)::text AS last_batch_run,
      COUNT(*)::int AS total_batch_runs,
      COALESCE(SUM(
        (SELECT COUNT(*) FROM descriptions d2
          WHERE d2.generated_at >= activity_logs.created_at - INTERVAL '5 seconds')
      ), 0)::int AS total_products_processed
    FROM activity_logs
    WHERE type = 'AI_GENERATION_BATCH'
      AND created_at >= NOW() - INTERVAL '7 days'
  `);

  return toApiDescriptionMetrics({ ...stats, ...batchInfo });
}

// ──────────────────────────────────────────────
// Multi-Channel Inventory Services
// ──────────────────────────────────────────────

/** Safe JSON parse that returns fallback on failure */
function tryParseJson(str, fallback = {}) {
  try { return JSON.parse(str); } catch { return fallback; }
}

/**
 * The configured safety buffer — what % of warehouse stock is sellable.
 * e.g. 90 → only 90% of warehouse stock can ever be sold, so returns,
 * damage and in-transit units never cause a stockout at the boundary.
 * Defaults to 100 (no buffer) when unset.
 *
 * @param {Function} [db] - query function; pass a client wrapper when called
 *   from inside a transaction so the read is consistent with it.
 */
export async function getSafetyBufferPercent(db = query) {
  const { rows } = await db('SELECT buffer_percent FROM safety_settings ORDER BY id DESC LIMIT 1');
  const pct = Number(rows.length ? rows[0].buffer_percent : Number(process.env.SAFETY_BUFFER_PERCENT ?? 100));
  if (!Number.isFinite(pct) || pct <= 0) return 100;
  return Math.min(100, Math.round(pct));
}

/**
 * Sellable units for a product under the safety buffer:
 *   sellable = floor(warehouse_quantity × buffer%)
 *   available = max(0, sellable − allocated_quantity)
 */
export function computeAvailableStock(warehouseQty, allocatedQty, bufferPercent) {
  const sellable = Math.floor(Number(warehouseQty) * Number(bufferPercent) / 100);
  return Math.max(0, sellable - Number(allocatedQty));
}

/**
 * Cache of channel code → DB id mapping.
 *
 * Phase 2: the cache now expires (default 60s, CHANNEL_ID_CACHE_TTL_MS) and is
 * invalidated by clearChannelIdCache() after seeding/mock-init, so newly added
 * channels are picked up instead of being invisible forever.
 */
const CHANNEL_ID_CACHE_TTL_MS = Math.max(1000, Number(process.env.CHANNEL_ID_CACHE_TTL_MS ?? 60_000));
let channelIdCache = null;
let channelIdCacheLoadedAt = 0;

async function getChannelIds() {
  if (channelIdCache && Date.now() - channelIdCacheLoadedAt < CHANNEL_ID_CACHE_TTL_MS) {
    return channelIdCache;
  }
  const { rows } = await query('SELECT id, code FROM channels');
  channelIdCache = Object.fromEntries(rows.map(r => [r.code, r.id]));
  channelIdCacheLoadedAt = Date.now();
  return channelIdCache;
}

/** Clear the channel ID cache (e.g. after seeding) */
export function clearChannelIdCache() {
  channelIdCache = null;
  channelIdCacheLoadedAt = 0;
}

export { getChannelIds };

/**
 * Transform a unified inventory query row into the API response format.
 *
 * NOTE: row.channel_quantities comes from PostgreSQL's json_object_agg()
 * which the pg library auto-parses into a JS object. It is NOT a string.
 */
export function toApiUnifiedInventoryItem(row, bufferPercent = 100) {
  // row.channel_quantities is already a JS object (pg auto-parses json type)
  const channelQtys =
    row.channel_quantities && typeof row.channel_quantities === 'object'
      ? row.channel_quantities
      : tryParseJson(row.channel_quantities);

  const warehouseQty = Number(row.warehouse_quantity ?? row.inventory ?? 0);
  const shopifyQty = Number(row.inventory ?? 0);
  const amazonQty = Number(channelQtys.AMAZON_MOCK ?? 0);
  const myntraQty = Number(channelQtys.MYNTRA_MOCK ?? 0);
  const flipkartQty = Number(channelQtys.FLIPKART_MOCK ?? 0);
  const totalChannelQty = shopifyQty + amazonQty + myntraQty + flipkartQty;
  const allocatedQty = Number(row.allocated_quantity ?? 0);
  // Available reflects the safety buffer, exactly as the over-order guard
  // computes it — so the UI can never show more sellable stock than the
  // guard will actually allow.
  const availableQty = computeAvailableStock(warehouseQty, allocatedQty, bufferPercent);

  // Determine risk status
  let riskStatus = 'OK';
  if (warehouseQty === 0 && totalChannelQty > 0) {
    riskStatus = 'CHANNEL_MISMATCH';
  } else if (totalChannelQty > availableQty) {
    riskStatus = 'OVERSELL_RISK';
  }

  return {
    productId: Number(row.id),
    productTitle: row.title,
    sku: row.sku ?? null,
    imageUrl: row.image_url ?? null,
    unitPrice: Number(row.price ?? 0),
    warehouseQuantity: warehouseQty,
    reservedQuantity: allocatedQty,
    availableQuantity: availableQty,
    shopifyQuantity: shopifyQty,
    amazonQuantity: amazonQty,
    myntraQuantity: myntraQty,
    flipkartQuantity: flipkartQty,
    totalChannelQuantity: totalChannelQty,
    riskStatus,
  };
}

/**
 * Get unified inventory for all products across all channels.
 * Returns a combined view with risk status.
 */
export async function getUnifiedInventory() {
  const bufferPercent = await getSafetyBufferPercent();
  // Phase 2: correlated per-product subquery replaced with a single LEFT JOIN
  // + GROUP BY aggregation (uses idx_channel_products_product).
  const { rows } = await query(`
    SELECT
      p.id,
      p.title,
      p.sku,
      p.image_url,
      p.price,
      p.warehouse_quantity,
      p.allocated_quantity,
      p.inventory,
      COALESCE(json_object_agg(c.code, cp.available_quantity) FILTER (WHERE c.code IS NOT NULL), '{}'::json) AS channel_quantities
    FROM products p
    LEFT JOIN channel_products cp ON cp.product_id = p.id
    LEFT JOIN channels c ON c.id = cp.channel_id
    GROUP BY p.id
    ORDER BY p.title ASC
  `);

  return rows.map((r) => toApiUnifiedInventoryItem(r, bufferPercent));
}

/**
 * Sync a single mock channel's inventory into the unified channel_products table.
 * Reads from the mock data store and upserts into the DB.
 *
 * @param {string} channelCode - e.g. 'AMAZON_MOCK'
 * @param {import('./channels/index.js').BaseChannelConnector} connector
 * @returns {Promise<{synced: number, updated: number, errors: string[]}>}
 */
export async function syncMockChannel(channelCode, connector) {
  const chIds = await getChannelIds();
  const channelId = chIds[channelCode];
  if (!channelId) throw new Error(`Unknown channel: ${channelCode}`);

  let inventory;
  try {
    inventory = await connector.fetchInventory();
  } catch (err) {
    await logActivity('CHANNEL_SYNC_ERROR', `Failed to fetch from ${channelCode}: ${err.message}`, 'ERROR');
    throw err;
  }

  let synced = 0;
  let updated = 0;
  const errors = [];

  for (const item of inventory) {
    try {
      // Find matching internal product by channel SKU or title
      let product;
      // First try by channel_sku in our DB
      const { rows: existingBySku } = await query(
        `SELECT cp.id, cp.product_id FROM channel_products cp
         WHERE cp.channel_id = $1 AND cp.channel_sku = $2 LIMIT 1`,
        [channelId, item.channelSku]
      );

      if (existingBySku.length > 0) {
        // Update existing
        await query(`
          UPDATE channel_products SET
            available_quantity = $1,
            title = $2,
            last_synced_at = NOW(),
            updated_at = NOW()
          WHERE id = $3
        `, [item.availableQuantity, item.title, existingBySku[0].id]);
        updated += 1;
      } else {
        // Find product by title fuzzy match
        const { rows: matchingProducts } = await query(
          `SELECT id FROM products WHERE title ILIKE $1 LIMIT 1`,
          [`%${item.title.substring(0, 30)}%`]
        );

        if (matchingProducts.length > 0) {
          await query(`
            INSERT INTO channel_products (product_id, channel_id, channel_sku, external_id, title, available_quantity, last_synced_at, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
            ON CONFLICT (product_id, channel_id) DO UPDATE SET
              available_quantity = EXCLUDED.available_quantity,
              channel_sku = EXCLUDED.channel_sku,
              title = EXCLUDED.title,
              last_synced_at = NOW(),
              updated_at = NOW()
          `, [matchingProducts[0].id, channelId, item.channelSku, item.externalId, item.title, item.availableQuantity]);
          synced += 1;
        } else {
          errors.push(`No matching product found for "${item.title}" (${item.channelSku})`);
        }
      }
    } catch (err) {
      errors.push(`Error syncing ${item.channelSku}: ${err.message}`);
    }
  }

  await logActivity(
    'CHANNEL_SYNC',
    `Synced ${channelCode}: ${synced} new, ${updated} updated, ${errors.length} error(s).`,
    errors.length ? 'WARNING' : 'SUCCESS'
  );

  return { synced, updated, errors };
}

/**
 * Update warehouse quantity for a product (for demo/testing purposes).
 */
export async function updateWarehouseQuantity(productId, newQuantity) {
  const qty = Math.max(0, Math.floor(Number(newQuantity)));
  const { rows } = await query(`
    UPDATE products SET warehouse_quantity = $1, updated_at = NOW() WHERE id = $2
    RETURNING id, title, sku, warehouse_quantity
  `, [qty, productId]);

  if (rows.length === 0) return null;

  await logActivity(
    'WAREHOUSE_QUANTITY_UPDATED',
    `Warehouse quantity updated for product #${productId} "${rows[0].title}" → ${qty}`,
    'INFO'
  );

  return {
    productId: Number(rows[0].id),
    productTitle: rows[0].title,
    sku: rows[0].sku,
    warehouseQuantity: Number(rows[0].warehouse_quantity),
  };
}

/**
 * Update a mock channel product's available quantity (for demo/testing purposes).
 * Uses UPSERT so it creates the record if it doesn't exist yet.
 *
 * @param {string} channelCode - 'AMAZON_MOCK', 'MYNTRA_MOCK', or 'FLIPKART_MOCK'
 * @param {number} productId - internal product ID
 * @param {number} newQuantity
 */
export async function updateChannelProductQuantity(channelCode, productId, newQuantity) {
  const chIds = await getChannelIds();
  const channelId = chIds[channelCode];
  if (!channelId) return null;

  const qty = Math.max(0, Math.floor(Number(newQuantity)));

  // Get product info (needed for both INSERT fallback and logging)
  const { rows: productRows } = await query(
    'SELECT id, title, sku FROM products WHERE id = $1',
    [productId]
  );
  if (productRows.length === 0) return null;

  const genSku = `${channelCode.substring(0, 3)}-${productRows[0].sku || `PROD-${productId}`}`;

  // Atomic UPSERT — creates or updates in a single query
  const { rows } = await query(`
    INSERT INTO channel_products (product_id, channel_id, channel_sku, title, available_quantity, last_synced_at, updated_at)
    VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
    ON CONFLICT (product_id, channel_id) DO UPDATE SET
      available_quantity = EXCLUDED.available_quantity,
      channel_sku = COALESCE(channel_products.channel_sku, EXCLUDED.channel_sku),
      title = EXCLUDED.title,
      updated_at = NOW(),
      last_synced_at = NOW()
    RETURNING *
  `, [productId, channelId, genSku, productRows[0].title, qty]);

  const result = rows[0];
  const isNew = result.created_at === result.updated_at; // heuristic: inserted just now

  await logActivity(
    'CHANNEL_QUANTITY_UPDATED',
    `${channelCode} quantity ${isNew ? 'created' : 'updated'} for product #${productId} "${productRows[0].title}" → ${qty}`,
    'INFO'
  );

  return {
    id: Number(result.id),
    productId: Number(result.product_id),
    channelCode,
    channelSku: result.channel_sku,
    availableQuantity: Number(result.available_quantity),
  };
}
