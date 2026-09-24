/**
 * Shopify webhook receiver + persistent event processor (Phase 3).
 *
 * Architecture: receiving is separated from processing.
 *
 *   Shopify → HMAC over RAW body → header validation → persist event
 *           → acknowledge → background processing → existing domain logic
 *
 * The database (webhook_events) is the source of truth for idempotency and
 * retry state — no in-memory Set/Map dedupes events. event_id has a UNIQUE
 * constraint, so concurrent duplicate deliveries are collapsed by PostgreSQL
 * (INSERT ... ON CONFLICT DO NOTHING).
 *
 * No new infrastructure: a PostgreSQL-backed queue drained by the existing
 * scheduler (and opportunistically right after receipt) is sufficient.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { query, withTransaction } from './database.js';
import { ApiError, ErrorCodes, validateWith } from './http.js';
import { SUPPORTED_WEBHOOK_TOPICS, webhookHeadersSchema, webhookPayloadSchema } from './validation.js';
import { logActivity, maybeCreateLowStockAlert, resolveProductInventoryAlert } from './lib.js';
import {
  WebhookPermanentError,
  applyShopifyOrder,
  cancelShopifyOrderByShopifyId,
  upsertProductsFromShopify,
  deleteProductByShopifyId,
  applyInventoryLevelUpdate,
} from './shopifyDomain.js';

export { WebhookPermanentError };

const SUPPORTED_TOPIC_SET = new Set(SUPPORTED_WEBHOOK_TOPICS);

// ──────────────────────────────────────────────
// Configuration (read at call time so ops/tests can change env freely)
// ──────────────────────────────────────────────
export function getWebhookConfig() {
  const retryBaseMs = Math.max(250, Number(process.env.WEBHOOK_RETRY_BASE_MS ?? 30_000));
  const retryMaxMs = Math.max(retryBaseMs, Number(process.env.WEBHOOK_RETRY_MAX_MS ?? 15 * 60_000));
  return {
    maxRetries: Math.max(1, Number(process.env.WEBHOOK_MAX_RETRIES ?? 5)),
    retryBaseMs,
    retryMaxMs,
    batchLimit: Math.max(1, Number(process.env.WEBHOOK_MAX_EVENTS_PER_RUN ?? 50)),
    processingStaleMs: Math.max(30_000, Number(process.env.WEBHOOK_PROCESSING_STALE_MS ?? 5 * 60_000)),
  };
}

function getWebhookSecret() {
  const secret = process.env.SHOPIFY_WEBHOOK_SECRET;
  return secret && secret.trim() ? secret : null;
}

/** Bounded exponential backoff with ±20% jitter. */
export function webhookBackoffMs(attempt) {
  const { retryBaseMs, retryMaxMs } = getWebhookConfig();
  const exponential = retryBaseMs * 2 ** Math.max(0, attempt - 1);
  const jitter = exponential * 0.2 * (Math.random() * 2 - 1);
  return Math.min(retryMaxMs, Math.max(0, Math.round(exponential + jitter)));
}

// ──────────────────────────────────────────────
// HMAC verification
// ──────────────────────────────────────────────
/**
 * Verify Shopify's HMAC-SHA256 signature against the ORIGINAL RAW body bytes.
 * Comparison is timing-safe and length-checked.
 *
 * @param {Buffer} rawBody
 * @param {string} hmacHeader - base64 value of X-Shopify-Hmac-Sha256
 * @param {string} secret
 * @returns {boolean}
 */
export function verifyShopifyHmac(rawBody, hmacHeader, secret) {
  if (!rawBody || !hmacHeader || !secret) return false;
  const digest = createHmac('sha256', secret).update(rawBody).digest();
  let provided;
  try {
    provided = Buffer.from(String(hmacHeader), 'base64');
  } catch {
    return false;
  }
  if (provided.length !== digest.length) return false;
  return timingSafeEqual(digest, provided);
}

// ──────────────────────────────────────────────
// Receiving
// ──────────────────────────────────────────────
/**
 * Verify, validate and persist an incoming Shopify webhook.
 * Throws ApiError for rejects (the router serializes it safely). On success
 * returns a small ack descriptor; processing happens afterward.
 *
 * @param {{rawBody: Buffer, headers: import('node:http').IncomingHttpHeaders}} params
 * @returns {Promise<{duplicate:boolean, eventId:string, topic:string, id?:number}>}
 */
export async function receiveShopifyWebhook({ rawBody, headers }) {
  // FAIL CLOSED: without a secret there is no way to authenticate Shopify, so
  // never process anything. Never bypass HMAC for convenience.
  const secret = getWebhookSecret();
  if (!secret) {
    console.error('[Webhook] SHOPIFY_WEBHOOK_SECRET is not configured — rejecting webhook (fail closed).');
    throw new ApiError(ErrorCodes.INTERNAL_ERROR, 'Webhook receiver is not configured');
  }

  const hmacHeader = headers['x-shopify-hmac-sha256'];
  if (typeof hmacHeader !== 'string' || hmacHeader.length === 0) {
    throw new ApiError(ErrorCodes.UNAUTHORIZED, 'Missing Shopify HMAC signature');
  }
  if (!verifyShopifyHmac(rawBody, hmacHeader, secret)) {
    throw new ApiError(ErrorCodes.UNAUTHORIZED, 'Invalid Shopify HMAC signature');
  }

  // Shopify sends both; X-Shopify-Event-Id is the documented stable event id,
  // X-Shopify-Webhook-Id is accepted as a forward-compatible fallback.
  const eventIdRaw = headers['x-shopify-event-id'] ?? headers['x-shopify-webhook-id'];
  const headerData = validateWith(webhookHeadersSchema, {
    topic: headers['x-shopify-topic'],
    eventId: eventIdRaw,
    shopDomain: headers['x-shopify-shop-domain'],
  });

  if (!SUPPORTED_TOPIC_SET.has(headerData.topic)) {
    throw new ApiError(ErrorCodes.VALIDATION_ERROR, 'Unsupported Shopify webhook topic');
  }

  // ONLY NOW parse — HMAC already verified against the raw bytes.
  let payload;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch {
    throw new ApiError(ErrorCodes.VALIDATION_ERROR, 'Malformed JSON body');
  }
  // Envelope check via the shared Phase 2 validation layer: a JSON object is
  // required; unknown/additional Shopify fields are always tolerated.
  validateWith(webhookPayloadSchema, payload);

  // Idempotent persist: the UNIQUE(event_id) constraint is the dedupe gate.
  const { rows } = await query(`
    INSERT INTO webhook_events (event_id, topic, shop_domain, payload, status, next_attempt_at)
    VALUES ($1, $2, $3, $4::jsonb, 'RECEIVED', NOW())
    ON CONFLICT (event_id) DO NOTHING
    RETURNING id
  `, [headerData.eventId, headerData.topic, headerData.shopDomain, JSON.stringify(payload)]);

  if (!rows.length) {
    console.log(`[Webhook] Duplicate ${headerData.topic} event ignored (event_id=${headerData.eventId}).`);
    return { duplicate: true, eventId: headerData.eventId, topic: headerData.topic };
  }

  const id = Number(rows[0].id);

  // Acknowledge first; process without blocking the HTTP response. The
  // scheduled worker is the safety net if this in-process attempt is lost.
  if (process.env.AUTOPILOT_WEBHOOK_INLINE_PROCESSING !== '0') {
    void processWebhookEventById(id).catch((err) => {
      console.error(`[Webhook] Inline processing failed for event ${id}:`, err?.message ?? err);
    });
  }

  return { duplicate: false, eventId: headerData.eventId, topic: headerData.topic, id };
}

// ──────────────────────────────────────────────
// Claiming (worker safety)
// ──────────────────────────────────────────────
/**
 * Atomically claim due events. Uses SELECT ... FOR UPDATE SKIP LOCKED inside a
 * transaction so overlapping worker invocations can never claim the same row,
 * and stale PROCESSING rows (crashed worker) become reclaimable.
 */
export async function claimDueWebhookEvents(limit = getWebhookConfig().batchLimit) {
  const cfg = getWebhookConfig();
  return withTransaction(async (client) => {
    const { rows } = await client.query(`
      UPDATE webhook_events
      SET status = 'PROCESSING', attempts = attempts + 1,
          last_attempt_at = NOW(), updated_at = NOW()
      WHERE id IN (
        SELECT id FROM webhook_events
        WHERE (
          status = 'RECEIVED'
          OR (status = 'RETRYING' AND next_attempt_at <= NOW())
          OR (status = 'PROCESSING' AND last_attempt_at < NOW() - make_interval(secs => $2 / 1000.0))
        )
          AND attempts < $3
        ORDER BY received_at ASC
        LIMIT $1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING *
    `, [limit, cfg.processingStaleMs, cfg.maxRetries]);
    return rows;
  });
}

/** Claim one specific event (used for immediate post-receipt processing). */
async function claimWebhookEventById(id) {
  const cfg = getWebhookConfig();
  const { rows } = await query(`
    UPDATE webhook_events
    SET status = 'PROCESSING', attempts = attempts + 1,
        last_attempt_at = NOW(), updated_at = NOW()
    WHERE id = $1 AND status IN ('RECEIVED', 'RETRYING') AND attempts < $2
    RETURNING *
  `, [id, cfg.maxRetries]);
  return rows[0] ?? null;
}

// ──────────────────────────────────────────────
// Processing
// ──────────────────────────────────────────────
/**
 * Default dispatcher: maps a topic + payload onto the shared domain layer.
 * Throws WebhookPermanentError for invalid payloads / unsupported topics so
 * the event is retained as FAILED rather than retried forever.
 */
export async function dispatchWebhookEvent(topic, payload) {
  switch (topic) {
    case 'orders/create':
    case 'orders/updated': {
      const result = await applyShopifyOrder(payload);
      await logActivity(
        'WEBHOOK_ORDER',
        `Processed ${topic} for Shopify order #${payload?.id} (allocation=${result.allocation?.status ?? result.allocationStatus}).`,
        result.allocation?.status === 'REJECTED' ? 'WARNING' : 'SUCCESS'
      );
      return result;
    }
    case 'orders/cancelled': {
      const result = await cancelShopifyOrderByShopifyId(Number(payload?.id));
      await logActivity(
        'WEBHOOK_ORDER',
        `Processed ${topic} for Shopify order #${payload?.id} (${result.status}).`,
        'INFO'
      );
      return result;
    }
    case 'products/create':
    case 'products/update': {
      const { upserted } = await upsertProductsFromShopify([payload]);
      if (upserted > 0) {
        // Re-read the persisted row so alert evaluation uses the actual stored
        // values (which may have been skipped as stale) and warehouse state.
        const { rows: [row] } = await query(
          `SELECT id, title, sku, inventory FROM products WHERE shopify_product_id = $1`,
          [Number(payload?.id)]
        );
        if (row) {
          await maybeEvaluateProductAlerts(row);
        }
      }
      await logActivity('WEBHOOK_PRODUCT', `Processed ${topic} for Shopify product #${payload?.id}.`, 'SUCCESS');
      return { upserted };
    }
    case 'products/delete': {
      const id = Number(payload?.id);
      if (!Number.isFinite(id)) throw new WebhookPermanentError('products/delete payload is missing a numeric id');
      const result = await deleteProductByShopifyId(id);
      await logActivity('WEBHOOK_PRODUCT', `Processed ${topic} for Shopify product #${id} (removed ${result.deleted}).`, 'INFO');
      return result;
    }
    case 'inventory_levels/update': {
      const result = await applyInventoryLevelUpdate(payload);
      await logActivity('WEBHOOK_INVENTORY', `Processed ${topic} for inventory item #${payload?.inventory_item_id} (${result.status}).`, 'INFO');
      return result;
    }
    default:
      throw new WebhookPermanentError(`Unsupported webhook topic: ${topic}`);
  }
}

/** Shared low-stock evaluation for a persisted product row. */
async function maybeEvaluateProductAlerts(row) {
  await maybeCreateLowStockAlert(row);
  await resolveProductInventoryAlert(row.id, row.inventory);
}

async function markWebhookProcessed(eventId) {
  await query(`
    UPDATE webhook_events
    SET status = 'PROCESSED', processed_at = NOW(), last_error = NULL,
        next_attempt_at = NULL, updated_at = NOW()
    WHERE id = $1
  `, [eventId]);
}

async function handleWebhookFailure(event, error) {
  const cfg = getWebhookConfig();
  const permanent = error instanceof WebhookPermanentError || error?.permanent === true;
  const attempts = Number(event.attempts) || 1;
  const exhausted = attempts >= cfg.maxRetries;
  const message = String(error?.message ?? 'unknown error').slice(0, 500);
  const category = permanent ? 'PERMANENT' : 'TRANSIENT';

  if (permanent || exhausted) {
    await query(`
      UPDATE webhook_events
      SET status = 'FAILED', next_attempt_at = NULL, last_error = $2, updated_at = NOW()
      WHERE id = $1
    `, [event.id, message]);
    await logActivity(
      'WEBHOOK_FAILED',
      `Webhook ${event.topic} event ${event.id} failed permanently after ${attempts} attempt(s) [${category}]: ${message}`,
      'ERROR'
    ).catch(() => {});
    console.error(`[Webhook] event ${event.id} (${event.topic}) FAILED [${category}] attempt ${attempts}/${cfg.maxRetries}: ${message}`);
    return { status: 'FAILED' };
  }

  const backoffMs = webhookBackoffMs(attempts);
  await query(`
    UPDATE webhook_events
    SET status = 'RETRYING',
        next_attempt_at = NOW() + make_interval(secs => $2 / 1000.0),
        last_error = $3, updated_at = NOW()
    WHERE id = $1
  `, [event.id, backoffMs, message]);
  console.error(`[Webhook] event ${event.id} (${event.topic}) transient failure — retry ${attempts}/${cfg.maxRetries} in ${Math.round(backoffMs / 1000)}s: ${message}`);
  return { status: 'RETRYING' };
}

/**
 * Process one already-claimed event. `dispatch` is injectable for tests.
 * @param {object} event - webhook_events row (status PROCESSING)
 * @param {Function} [dispatch]
 */
export async function processClaimedWebhookEvent(event, dispatch = dispatchWebhookEvent) {
  const startedAt = Date.now();
  try {
    await dispatch(event.topic, event.payload);
    await markWebhookProcessed(event.id);
    console.log(`[Webhook] ${event.topic} event ${event.id} processed in ${Date.now() - startedAt}ms (attempt ${event.attempts}).`);
    return { status: 'PROCESSED' };
  } catch (error) {
    return handleWebhookFailure(event, error);
  }
}

/**
 * Claim and process a single event by id. Returns { status: 'SKIPPED' } when
 * the event is not claimable (already processed/in-flight/out of budget).
 */
export async function processWebhookEventById(id, dispatch = dispatchWebhookEvent) {
  const event = await claimWebhookEventById(id);
  if (!event) return { status: 'SKIPPED' };
  return processClaimedWebhookEvent(event, dispatch);
}

/**
 * Drain due events. Safe to call concurrently and repeatedly — claiming is
 * atomic, so no event is ever processed twice by overlapping runs.
 */
export async function processPendingWebhookEvents({ limit, dispatch = dispatchWebhookEvent } = {}) {
  const claimed = await claimDueWebhookEvents(limit);
  if (!claimed.length) return { processed: 0, retried: 0, failed: 0, total: 0 };

  let processed = 0;
  let retried = 0;
  let failed = 0;
  for (const event of claimed) {
    const outcome = await processClaimedWebhookEvent(event, dispatch);
    if (outcome.status === 'PROCESSED') processed += 1;
    else if (outcome.status === 'RETRYING') retried += 1;
    else failed += 1;
  }
  return { processed, retried, failed, total: claimed.length };
}
