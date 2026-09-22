// End-to-end API tests (Phase 2): run the REAL http server on an ephemeral
// port and exercise authentication, validation, error format and pagination.
process.env.AUTOPILOT_SKIP_START = '1';
process.env.EMAIL_MOCK_MODE = '1';
process.env.NODE_ENV = 'test';

import test from 'node:test';
import assert from 'node:assert/strict';
import { initializeDatabase, query, closeDatabase } from '../src/database.js';

// NB: ESM static imports are hoisted and evaluated BEFORE the env assignments
// above run — server.js must be imported dynamically so that
// AUTOPILOT_SKIP_START (and the API key config below) are already in effect.
const { server } = await import('../src/server.js');
const { configureApiKey, resetApiKeyState } = await import('../src/auth.js');

const API_KEY = 'e2e-test-key-98765';
let baseUrl;

async function api(path, { method = 'GET', headers = {}, body, apiKey = API_KEY } = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(apiKey ? { 'X-API-Key': apiKey } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  return { status: res.status, json, text };
}

test('API E2E — auth, validation, errors, pagination', { timeout: 90_000 }, async (t) => {
  await initializeDatabase();

  // Reset auth state to the configured test key
  process.env.AUTOPILOT_API_KEY = API_KEY;
  configureApiKey();

  // Start the real server on an ephemeral port
  await new Promise((resolve) => server.listen(0, () => resolve()));
  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;
  t.after(() => new Promise((resolve) => server.close(resolve)));
  t.after(() => { resetApiKeyState(); delete process.env.AUTOPILOT_API_KEY; });
  t.after(() => closeDatabase());

  // ── AUTH ────────────────────────────────────────────────────────
  await t.test('401 when API key is missing on a protected endpoint', async () => {
    const r = await api('/api/orders/intake', { method: 'POST', apiKey: null, body: {} });
    assert.equal(r.status, 401);
    assert.equal(r.json.error.code, 'UNAUTHORIZED');
  });

  await t.test('401 when API key is invalid', async () => {
    const r = await api('/api/orders/intake', { method: 'POST', apiKey: 'wrong-key', body: {} });
    assert.equal(r.status, 401);
    assert.equal(r.json.error.code, 'UNAUTHORIZED');
    // The configured key must never appear in the response
    assert.ok(!r.text.includes(API_KEY));
  });

  await t.test('valid API key proceeds on a protected endpoint', async () => {
    const r = await api('/api/kpis');
    assert.equal(r.status, 200);
  });

  // ── ROUTE PROTECTION DECISIONS (Phase 2 final) ──
  await t.test('operational reads (kpis, scheduler) require the API key', async () => {
    assert.equal((await api('/api/kpis', { apiKey: null })).status, 401);
    assert.equal((await api('/api/scheduler/status', { apiKey: null })).status, 401);
    assert.equal((await api('/api/scheduler/runs', { apiKey: null })).status, 401);
    // ...and succeed with the key
    assert.equal((await api('/api/scheduler/status')).status, 200);
  });

  await t.test('/api/shopify/* GET aliases stay public like their primaries', async () => {
    for (const p of ['/api/shopify/products?limit=1', '/api/shopify/orders?limit=1', '/api/shopify/inventory?limit=1']) {
      const r = await api(p, { apiKey: null });
      assert.equal(r.status, 200, `${p} should be public`);
    }
  });

  await t.test('public endpoints work without an API key', async () => {
    const health = await api('/actuator/health', { apiKey: null });
    assert.equal(health.status, 200);
    assert.equal(health.json.status, 'UP');

    const check = await api('/api/orders/check', {
      method: 'POST',
      apiKey: null,
      body: { items: [{ productId: 1, quantity: 1 }] },
    });
    assert.ok([200, 404].includes(check.status), 'check is public even when product is missing');
  });

  // ── VALIDATION / ERROR FORMAT ────────────────────────────────────
  await t.test('malformed JSON body → 400 VALIDATION_ERROR envelope', async () => {
    const res = await fetch(`${baseUrl}/api/orders/intake`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': API_KEY },
      body: '{"broken": ',
    });
    assert.equal(res.status, 400);
    const json = await res.json();
    assert.equal(json.error.code, 'VALIDATION_ERROR');
    assert.equal(json.error.message, 'Malformed JSON body');
  });

  await t.test('invalid order intake payload → 400 with safe field errors', async () => {
    const r = await api('/api/orders/intake', {
      method: 'POST',
      body: { channel: 'SHOPIFY', items: [{ productId: 1, quantity: 0 }] },
    });
    assert.equal(r.status, 400);
    assert.equal(r.json.error.code, 'VALIDATION_ERROR');
    assert.ok(r.json.error.fields.length >= 1);
    // quantity of 0 must be reported — not echoed request content
    assert.ok(JSON.stringify(r.json.error.fields).includes('quantity'));
  });

  await t.test('order intake with negative quantity → 400', async () => {
    const r = await api('/api/orders/intake', {
      method: 'POST',
      body: { channel: 'SHOPIFY', items: [{ productId: 1, quantity: -5 }] },
    });
    assert.equal(r.status, 400);
    assert.equal(r.json.error.code, 'VALIDATION_ERROR');
  });

  await t.test('order intake with non-integer quantity → 400', async () => {
    const r = await api('/api/orders/intake', {
      method: 'POST',
      body: { channel: 'SHOPIFY', items: [{ productId: 1, quantity: 1.5 }] },
    });
    assert.equal(r.status, 400);
  });

  await t.test('invalid pagination params → 400', async () => {
    const r1 = await api('/api/products?page=0');
    assert.equal(r1.status, 400);
    const r2 = await api('/api/products?limit=99999');
    assert.equal(r2.status, 400);
    const r3 = await api('/api/products?page=abc');
    assert.equal(r3.status, 400);
  });

  // ── /api/inventory PAGINATION (regression: manual clamp → 500 on limit=2.5) ──
  await t.test('inventory pagination uses the shared schema: fractional/invalid → 400', async () => {
    for (const qs of ['limit=2.5', 'page=abc', 'limit=0', 'page=0', 'limit=100000']) {
      const r = await api(`/api/inventory?${qs}`);
      assert.equal(r.status, 400, `?${qs} must be 400`);
      assert.equal(r.json.error.code, 'VALIDATION_ERROR', `?${qs} envelope`);
    }
  });

  await t.test('inventory pagination accepts valid page/limit with the standard envelope', async () => {
    const r = await api('/api/inventory?page=1&limit=5');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.json.data));
    assert.deepEqual(r.json.pagination, {
      page: 1, limit: 5, total: r.json.pagination.total,
      totalPages: Math.max(1, Math.ceil(r.json.pagination.total / 5)),
    });
  });

  await t.test('invalid enum (unknown channel) → 400', async () => {
    const r = await api('/api/orders/intake', {
      method: 'POST',
      body: { channel: 'ETSY', items: [{ productId: 1, quantity: 1 }] },
    });
    assert.equal(r.status, 400);
    assert.equal(r.json.error.code, 'VALIDATION_ERROR');
  });

  await t.test('safety buffer out of range → 400', async () => {
    const r = await api('/api/inventory/safety-buffer', { method: 'PUT', body: { bufferPercent: 150 } });
    assert.equal(r.status, 400);
    assert.equal(r.json.error.code, 'VALIDATION_ERROR');
  });

  // ── 404 ─────────────────────────────────────────────────────────
  await t.test('unknown route → 404 envelope', async () => {
    const r = await api('/api/does-not-exist');
    assert.equal(r.status, 404);
    assert.equal(r.json.error.code, 'NOT_FOUND');
  });

  await t.test('missing resource → 404 envelope', async () => {
    const r = await api('/api/orders/999999999');
    assert.equal(r.status, 404);
    assert.equal(r.json.error.code, 'NOT_FOUND');
  });

  // ── PAGINATION ──────────────────────────────────────────────────
  await t.test('paginated list endpoints return the documented envelope', async () => {
    const r = await api('/api/products?page=1&limit=5');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.json.data));
    assert.deepEqual(r.json.pagination, {
      page: 1, limit: 5, total: r.json.pagination.total,
      totalPages: Math.max(1, Math.ceil(r.json.pagination.total / 5)),
    });

    const logs = await api('/api/activity-logs?page=1&limit=3');
    assert.equal(logs.status, 200);
    assert.ok(logs.json.data.length <= 3);
    assert.equal(typeof logs.json.pagination.total, 'number');

    const orders = await api('/api/orders?limit=2');
    assert.equal(orders.status, 200);
    assert.ok(Array.isArray(orders.json.data));

    const descs = await api('/api/descriptions?limit=4');
    assert.equal(descs.status, 200);
    assert.deepEqual(descs.json.pagination, {
      page: 1, limit: 4, total: descs.json.pagination.total,
      totalPages: Math.max(1, Math.ceil(descs.json.pagination.total / 4)),
    });
  });

  await t.test('pagination metadata is self-consistent per response', async () => {
    // NB: the full suite runs test files in parallel against one DB, so rows
    // can appear between two requests — assert each response's internal
    // consistency rather than equality of totals across requests.
    for (const page of [1, 2]) {
      const r = await api(`/api/activity-logs?page=${page}&limit=2`);
      assert.equal(r.status, 200);
      assert.equal(r.json.pagination.page, page);
      assert.equal(r.json.pagination.limit, 2);
      assert.equal(
        r.json.pagination.totalPages,
        Math.max(1, Math.ceil(r.json.pagination.total / 2))
      );
      assert.ok(r.json.data.length <= 2);
    }
  });

  // ── ERROR SANITIZATION ──────────────────────────────────────────
  await t.test('404 route never leaks stack traces', async () => {
    const r = await api('/api/nope');
    assert.ok(!r.text.includes('at ') || !r.text.includes('stack'));
  });
});
