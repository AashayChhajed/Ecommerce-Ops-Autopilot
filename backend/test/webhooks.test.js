// Phase 3 — Shopify webhook receiver: HMAC verification, header validation,
// idempotency and security. Runs the REAL http server on an ephemeral port and
// speaks to it with real fetch requests (raw bytes are what HMAC signs).
process.env.AUTOPILOT_SKIP_START = '1';
process.env.EMAIL_MOCK_MODE = '1';
process.env.NODE_ENV = 'test';
process.env.SHOPIFY_WEBHOOK_SECRET = 'wh-test-secret-2026';
process.env.AUTOPILOT_WEBHOOK_INLINE_PROCESSING = '0'; // deterministic: tests drive the worker
process.env.WEBHOOK_MAX_RETRIES = '3';
process.env.WEBHOOK_RETRY_BASE_MS = '50';
process.env.WEBHOOK_RETRY_MAX_MS = '200';
process.env.MAX_BODY_BYTES = '8192'; // keep the oversize test light

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { initializeDatabase, query, closeDatabase } from '../src/database.js';

// Dynamic import so AUTOPILOT_SKIP_START / env above are already in effect.
const { server } = await import('../src/server.js');

const SECRET = process.env.SHOPIFY_WEBHOOK_SECRET;
const EVENT_PREFIX = 'WH-TEST-';
const PRODUCT_BASE = 981000000; // reserved for THIS file: 981000000–981000099
const PRODUCT_CEIL = 981000099;

let baseUrl;

function sign(raw) {
  return createHmac('sha256', SECRET).update(raw).digest('base64');
}

/**
 * Build Shopify webhook headers. Pass `hmac: null` to omit the signature
 * header entirely; pass `hmac: 'x'` to send a bogus one.
 */
function buildHeaders(raw, opts = {}) {
  const headers = {
    'Content-Type': 'application/json',
    'X-Shopify-Topic': opts.topic ?? 'products/create',
    'X-Shopify-Event-Id': opts.eventId ?? `${EVENT_PREFIX}${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    'X-Shopify-Shop-Domain': opts.shopDomain ?? 'test-shop.myshopify.com',
  };
  if (opts.hmac !== null) headers['X-Shopify-Hmac-Sha256'] = opts.hmac ?? sign(raw);
  if (opts.omitTopic) delete headers['X-Shopify-Topic'];
  if (opts.omitEventId) delete headers['X-Shopify-Event-Id'];
  if (opts.omitShopDomain) delete headers['X-Shopify-Shop-Domain'];
  return { ...headers, ...(opts.extra ?? {}) };
}

async function post(body, opts = {}) {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  const res = await fetch(`${baseUrl}/api/webhooks/shopify`, {
    method: 'POST',
    headers: buildHeaders(raw, opts),
    body: raw,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  return { status: res.status, json, text, raw };
}

async function eventRow(eventId) {
  const { rows } = await query('SELECT * FROM webhook_events WHERE event_id = $1', [eventId]);
  return rows[0] ?? null;
}

async function cleanup() {
  await query(`DELETE FROM webhook_events WHERE event_id LIKE $1`, [`${EVENT_PREFIX}%`]).catch(() => {});
  await query(`DELETE FROM products WHERE shopify_product_id BETWEEN $1 AND $2`, [PRODUCT_BASE, PRODUCT_CEIL]).catch(() => {});
}

test('Shopify webhooks — HMAC, validation, idempotency, security', { timeout: 90_000 }, async (t) => {
  await initializeDatabase();
  await cleanup();

  await new Promise((resolve) => server.listen(0, () => resolve()));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  t.after(() => new Promise((resolve) => server.close(resolve)));
  t.after(cleanup);
  t.after(() => closeDatabase());

  const validPayload = () => ({ id: PRODUCT_BASE + 1, title: 'Webhook Product', status: 'active', variants: [] });

  // ── A. HMAC ─────────────────────────────────────────────────────
  await t.test('valid HMAC is accepted and the event is persisted', async () => {
    const eventId = `${EVENT_PREFIX}valid-1`;
    const r = await post(validPayload(), { eventId, topic: 'products/create' });
    assert.equal(r.status, 200);
    assert.equal(r.json.received, true);
    assert.equal(r.json.duplicate, false);

    const row = await eventRow(eventId);
    assert.ok(row, 'event must be persisted');
    assert.equal(row.topic, 'products/create');
    assert.equal(row.shop_domain, 'test-shop.myshopify.com');
    // Inline processing is disabled here, but a parallel processing test may
    // have drained the global queue — the point is that the event PERSISTED and
    // is in a valid pre/post-processing state, never FAILED/discarded.
    assert.ok(['RECEIVED', 'PROCESSING', 'PROCESSED'].includes(row.status), `unexpected status ${row.status}`);
    assert.equal(Number(row.payload.id), PRODUCT_BASE + 1);
    // The secret must never appear in any response.
    assert.ok(!r.text.includes(SECRET));
  });

  await t.test('invalid HMAC is rejected with 401 and never persists the event', async () => {
    const raw = JSON.stringify(validPayload());
    const eventId = `${EVENT_PREFIX}bad-hmac`;
    const r = await post(raw, { eventId, hmac: sign('a totally different body') });
    assert.equal(r.status, 401);
    assert.equal(r.json.error.code, 'UNAUTHORIZED');
    assert.equal(await eventRow(eventId), null);
    assert.ok(!r.text.includes(SECRET));
  });

  await t.test('missing HMAC is rejected with 401 and never persists the event', async () => {
    const eventId = `${EVENT_PREFIX}no-hmac`;
    const r = await post(validPayload(), { eventId, hmac: null });
    assert.equal(r.status, 401);
    assert.equal(r.json.error.code, 'UNAUTHORIZED');
    assert.equal(await eventRow(eventId), null);
  });

  await t.test('a MODIFIED body fails verification (signature is over raw bytes)', async () => {
    const raw = JSON.stringify(validPayload());
    const sig = sign(raw);
    const tampered = raw.replace('Webhook Product', 'Tampered Product');
    const eventId = `${EVENT_PREFIX}tampered`;
    const res = await fetch(`${baseUrl}/api/webhooks/shopify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Hmac-Sha256': sig,
        'X-Shopify-Topic': 'products/create',
        'X-Shopify-Event-Id': eventId,
        'X-Shopify-Shop-Domain': 'test-shop.myshopify.com',
      },
      body: tampered,
    });
    assert.equal(res.status, 401);
    assert.equal(await eventRow(eventId), null);
  });

  // ── B. Headers ──────────────────────────────────────────────────
  await t.test('missing event id → 400', async () => {
    const r = await post(validPayload(), { omitEventId: true });
    assert.equal(r.status, 400);
    assert.equal(r.json.error.code, 'VALIDATION_ERROR');
  });

  await t.test('missing topic → 400', async () => {
    const r = await post(validPayload(), { omitTopic: true });
    assert.equal(r.status, 400);
    assert.equal(r.json.error.code, 'VALIDATION_ERROR');
  });

  await t.test('missing shop domain → 400', async () => {
    const r = await post(validPayload(), { omitShopDomain: true });
    assert.equal(r.status, 400);
    assert.equal(r.json.error.code, 'VALIDATION_ERROR');
  });

  await t.test('unsupported topic → 400 and not persisted', async () => {
    const eventId = `${EVENT_PREFIX}unsupported`;
    const r = await post({ id: 1 }, { eventId, topic: 'customers/create' });
    assert.equal(r.status, 400);
    assert.equal(r.json.error.code, 'VALIDATION_ERROR');
    assert.equal(await eventRow(eventId), null);
  });

  // ── C. Malformed / oversize bodies ──────────────────────────────
  await t.test('malformed JSON (correctly signed) → 400 and not persisted', async () => {
    const raw = '{"broken": ';
    const eventId = `${EVENT_PREFIX}malformed`;
    const r = await post(raw, { eventId, hmac: sign(raw) });
    assert.equal(r.status, 400);
    assert.equal(r.json.error.code, 'VALIDATION_ERROR');
    assert.equal(await eventRow(eventId), null);
  });

  await t.test('a JSON array payload (correctly signed) → 400', async () => {
    const r = await post([1, 2, 3], {});
    assert.equal(r.status, 400);
    assert.equal(r.json.error.code, 'VALIDATION_ERROR');
  });

  await t.test('oversized payload → 400', async () => {
    const raw = JSON.stringify({ id: 1, blob: 'x'.repeat(20_000) });
    const r = await post(raw, { hmac: sign(raw) });
    assert.equal(r.status, 400);
    assert.equal(r.json.error.code, 'VALIDATION_ERROR');
    assert.match(r.json.error.message, /too large/i);
  });

  // ── D. Idempotency ──────────────────────────────────────────────
  await t.test('duplicate delivery returns an acknowledgement and creates no second row', async () => {
    const eventId = `${EVENT_PREFIX}dup-1`;
    const first = await post(validPayload(), { eventId });
    assert.equal(first.status, 200);
    assert.equal(first.json.duplicate, false);

    const second = await post(validPayload(), { eventId });
    assert.equal(second.status, 200);
    assert.equal(second.json.duplicate, true, 'duplicate is acknowledged, not reprocessed');

    const { rows: [count] } = await query(
      'SELECT COUNT(*)::int AS n FROM webhook_events WHERE event_id = $1',
      [eventId]
    );
    assert.equal(count.n, 1, 'UNIQUE(event_id) keeps exactly one row');
  });

  await t.test('concurrent duplicate deliveries collapse to a single event', async () => {
    const eventId = `${EVENT_PREFIX}dup-concurrent`;
    const results = await Promise.all(
      Array.from({ length: 6 }, () => post(validPayload(), { eventId }))
    );
    for (const r of results) assert.equal(r.status, 200);

    const acceptedNew = results.filter((r) => r.json.duplicate === false).length;
    assert.equal(acceptedNew, 1, 'exactly one delivery is treated as new');

    const { rows: [count] } = await query(
      'SELECT COUNT(*)::int AS n FROM webhook_events WHERE event_id = $1',
      [eventId]
    );
    assert.equal(count.n, 1, 'concurrent duplicates insert exactly one row');
  });

  // ── E. Security ─────────────────────────────────────────────────
  await t.test('no API key is required, and an invalid API key is irrelevant', async () => {
    // No X-API-Key at all (post() never sends one) — the valid-HMAC test above
    // already proves it. Here we add a WRONG X-API-Key to prove it is ignored.
    const r = await post(validPayload(), { extra: { 'X-API-Key': 'not-the-key' } });
    assert.equal(r.status, 200);
    assert.equal(r.json.received, true);
  });

  await t.test('the API key can NOT substitute for HMAC verification', async () => {
    const eventId = `${EVENT_PREFIX}key-not-hmac`;
    const r = await post(validPayload(), { eventId, hmac: null, extra: { 'X-API-Key': 'anything' } });
    assert.equal(r.status, 401);
    assert.equal(r.json.error.code, 'UNAUTHORIZED');
    assert.equal(await eventRow(eventId), null);
  });

  await t.test('rejections never leak secrets or stack traces', async () => {
    const r = await post(validPayload(), { hmac: 'AAAA', extra: {} });
    assert.equal(r.status, 401);
    assert.ok(!r.text.includes(SECRET), 'secret never serialized');
    assert.ok(!/at .*\(.*:\d+:\d+\)/.test(r.text), 'no stack trace in the body');
  });
});
