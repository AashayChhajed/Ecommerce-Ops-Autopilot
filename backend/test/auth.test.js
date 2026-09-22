// Unit tests for the Phase 2 auth middleware — no DB or HTTP server needed.
process.env.AUTOPILOT_SKIP_START = '1';

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  safeEqual,
  requireApiKey,
  isProtected,
  configureApiKey,
  resetApiKeyState,
  authEnabled,
  assertProductionAuth,
} from '../src/auth.js';

test('safeEqual accepts identical strings and rejects different ones', () => {
  assert.equal(safeEqual('secret-key', 'secret-key'), true);
  assert.equal(safeEqual('secret-key', 'wrong-key'), false);
  assert.equal(safeEqual('short', 'longer-string'), false);
  assert.equal(safeEqual('', ''), true);
});

test('safeEqual is deterministic and never throws on odd input', () => {
  for (let i = 0; i < 10; i++) {
    assert.equal(safeEqual('a-key', 'a-key'), true);
    assert.equal(safeEqual('a-key', 'b-key'), false);
  }
  assert.doesNotThrow(() => safeEqual(undefined, null));
});

test('requireApiKey passes when no key is configured (dev mode)', () => {
  resetApiKeyState();
  assert.equal(authEnabled(), false);
  assert.doesNotThrow(() => requireApiKey({ headers: {} }));
});

test('requireApiKey enforces the key when configured', () => {
  process.env.AUTOPILOT_API_KEY = 'test-key-12345';
  configureApiKey();
  assert.equal(authEnabled(), true);

  // Missing header → 401
  assert.throws(() => requireApiKey({ headers: {} }), (err) => err.status === 401);

  // Invalid key → 401
  assert.throws(() => requireApiKey({ headers: { 'x-api-key': 'wrong' } }), (err) => err.status === 401);

  // Valid key → proceeds
  assert.doesNotThrow(() => requireApiKey({ headers: { 'x-api-key': 'test-key-12345' } }));

  // Empty header → 401
  assert.throws(() => requireApiKey({ headers: { 'x-api-key': '' } }), (err) => err.status === 401);

  resetApiKeyState();
  delete process.env.AUTOPILOT_API_KEY;
});

test('isProtected classifies public vs protected endpoints correctly', () => {
  // Public: health probes
  assert.equal(isProtected('GET', '/health'), false);
  assert.equal(isProtected('GET', '/actuator/health'), false);

  // Public: allowlisted read-only dashboards
  assert.equal(isProtected('GET', '/api/products'), false);
  assert.equal(isProtected('GET', '/api/orders'), false);
  assert.equal(isProtected('GET', '/api/products/42'), false);
  assert.equal(isProtected('GET', '/api/products/42/description'), false);
  assert.equal(isProtected('GET', '/api/orders/42'), false);

  // Public: /api/shopify/* GET aliases are classified identically to their
  // primary equivalents (/api/products, /api/orders, /api/inventory)
  assert.equal(isProtected('GET', '/api/shopify/products'), false);
  assert.equal(isProtected('GET', '/api/shopify/orders'), false);
  assert.equal(isProtected('GET', '/api/shopify/inventory'), false);

  // Protected: operational/sensitive reads (business metrics, job errors)
  assert.equal(isProtected('GET', '/api/kpis'), true);
  assert.equal(isProtected('GET', '/api/scheduler/status'), true);
  assert.equal(isProtected('GET', '/api/scheduler/runs'), true);

  // Public: non-mutating availability check
  assert.equal(isProtected('POST', '/api/orders/check'), false);

  // Protected: every mutation / admin action
  assert.equal(isProtected('POST', '/api/orders/intake'), true);
  assert.equal(isProtected('POST', '/api/shopify/sync'), true);
  assert.equal(isProtected('POST', '/api/orders/notify'), true);
  assert.equal(isProtected('PUT', '/api/inventory/safety-buffer'), true);
  assert.equal(isProtected('POST', '/api/products/1/generate-description'), true);
  assert.equal(isProtected('POST', '/api/descriptions/approve/1'), true);
  assert.equal(isProtected('POST', '/api/test-email/order'), true);
  assert.equal(isProtected('POST', '/api/inventory/sync-all'), true);
  assert.equal(isProtected('POST', '/api/descriptions/settings'), true);

  // Protected: sneaky mutations of read paths
  assert.equal(isProtected('DELETE', '/api/products'), true);
  assert.equal(isProtected('POST', '/api/products'), true);
});

test('production fails closed: startup refuses to boot without AUTOPILOT_API_KEY', () => {
  const prevNodeEnv = process.env.NODE_ENV;
  const prevKey = process.env.AUTOPILOT_API_KEY;
  try {
    process.env.NODE_ENV = 'production';
    delete process.env.AUTOPILOT_API_KEY;
    resetApiKeyState();
    assert.throws(
      () => assertProductionAuth(),
      (err) => /AUTOPILOT_API_KEY/.test(err.message) && /production/.test(err.message)
    );

    // With a key configured, production startup is allowed
    process.env.AUTOPILOT_API_KEY = 'prod-test-key';
    configureApiKey();
    assert.doesNotThrow(() => assertProductionAuth());

    // Defense in depth: even if the guard were bypassed, requireApiKey
    // must NOT fail open in production — it rejects every request instead.
    delete process.env.AUTOPILOT_API_KEY;
    resetApiKeyState();
    assert.throws(
      () => requireApiKey({ headers: { 'x-api-key': 'anything' } }),
      (err) => err.status === 500
    );
    assert.throws(
      () => requireApiKey({ headers: {} }),
      (err) => err.status === 500
    );
  } finally {
    resetApiKeyState();
    if (prevKey === undefined) delete process.env.AUTOPILOT_API_KEY;
    else process.env.AUTOPILOT_API_KEY = prevKey;
    if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prevNodeEnv;
    configureApiKey();
  }
});

test('development (non-production) keeps documented fail-open behavior without a key', () => {
  const prevNodeEnv = process.env.NODE_ENV;
  try {
    delete process.env.NODE_ENV;
    resetApiKeyState();
    assert.doesNotThrow(() => requireApiKey({ headers: {} }));
    assert.doesNotThrow(() => assertProductionAuth());
  } finally {
    resetApiKeyState();
    if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prevNodeEnv;
  }
});
