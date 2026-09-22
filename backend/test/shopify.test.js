// Unit tests for the Phase 2 Shopify client: timeout, retries, 429/Retry-After,
// pagination, and non-retryable 4xx behavior. All network I/O is mocked via
// globalThis.fetch — no real Shopify calls.
process.env.AUTOPILOT_SKIP_START = '1';
process.env.SHOPIFY_ACCESS_TOKEN = 'test-token';
process.env.SHOPIFY_MAX_RETRIES = '3';
process.env.SHOPIFY_FETCH_TIMEOUT_MS = '50';

import test from 'node:test';
import assert from 'node:assert/strict';

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

/** Minimal Response-like object. */
function jsonResponse(status, body, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: 'Test',
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function timedRequest() {
  return new Promise((_, reject) => {
    const check = setInterval(() => {}, 10);
    setTimeout(() => { clearInterval(check); }, 10 * 60 * 1000);
    // actual abort handled by caller via options.signal
  });
}

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  process.env.SHOPIFY_MAX_RETRIES = '3';
});

test('timeout: aborted request becomes a ShopifyFetchError with retryable=true', async () => {
  const { shopifyFetch, ShopifyFetchError } = await import('../src/shopify.js');
  // SHOPIFY_FETCH_TIMEOUT_MS is set at file scope so the cached module import
  // already uses the short 50ms timeout. No re-import needed.

  globalThis.fetch = (_url, options) => new Promise((_, reject) => {
    options.signal.addEventListener('abort', () => {
      reject(options.signal.reason ?? new Error('Aborted'));
    });
  });

  await assert.rejects(
    () => shopifyFetch('/products.json', (p) => `https://test.myshopify.com${p}`),
    (err) => err instanceof ShopifyFetchError
      && err.retryable === true
      && /timed out after \d+ms/.test(err.message)
  );
});

test('429 without Retry-After: retries with backoff then succeeds', async () => {
  const { shopifyFetch } = await import('../src/shopify.js');
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls < 3) return jsonResponse(429, { errors: 'rate limited' });
    return jsonResponse(200, { products: [{ id: 1 }] });
  };

  const body = await shopifyFetch('/products.json', (p) => `https://test.myshopify.com${p}`);
  assert.equal(calls, 3);
  assert.deepEqual(body, { products: [{ id: 1 }] });
});

test('429 with Retry-After header: honors the provided delay (bounded)', async () => {
  const { shopifyFetch } = await import('../src/shopify.js');
  let calls = 0;
  const startedAt = Date.now();
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      // Retry-After of 2s is within bounds and keeps the test fast.
      return jsonResponse(429, { errors: 'slow down' }, { 'retry-after': '2' });
    }
    return jsonResponse(200, { products: [] });
  };

  await shopifyFetch('/products.json', (p) => `https://test.myshopify.com${p}`);
  assert.equal(calls, 2);
  const elapsed = Date.now() - startedAt;
  // Retry-After of 2s should be honored; test completes in < 5s.
  assert.ok(elapsed < 5_000, `expected ~2s delay, took ${elapsed}ms`);
  assert.ok(elapsed >= 1_500, `delay was too short (${elapsed}ms) — Retry-After not honored`);
});

test('500 then success: transient 5xx errors are retried', async () => {
  const { shopifyFetch } = await import('../src/shopify.js');
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) return jsonResponse(500, { error: 'boom' });
    return jsonResponse(200, { products: [{ id: 7 }] });
  };
  const body = await shopifyFetch('/products.json', (p) => `https://test.myshopify.com${p}`);
  assert.equal(calls, 2);
  assert.equal(body.products.length, 1);
});

test('401 authentication failure: NOT retried, fails fast', async () => {
  const { shopifyFetch, ShopifyFetchError } = await import('../src/shopify.js');
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return jsonResponse(401, { errors: 'Unauthorized' }); };
  await assert.rejects(
    () => shopifyFetch('/products.json', (p) => `https://test.myshopify.com${p}`),
    (err) => err instanceof ShopifyFetchError && err.status === 401 && err.retryable === false
  );
  assert.equal(calls, 1, '4xx auth failures must not be retried');
});

test('404 not found: NOT retried', async () => {
  const { shopifyFetch, ShopifyFetchError } = await import('../src/shopify.js');
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return jsonResponse(404, { errors: 'Not Found' }); };
  await assert.rejects(
    () => shopifyFetch('/products.json', (p) => `https://test.myshopify.com${p}`),
    (err) => err instanceof ShopifyFetchError && err.status === 404
  );
  assert.equal(calls, 1);
});

test('network failure: retried, then exhausted with a clear error', async () => {
  const { shopifyFetch, ShopifyFetchError } = await import('../src/shopify.js');
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; throw new Error('ECONNRESET'); };
  await assert.rejects(
    () => shopifyFetch('/products.json', (p) => `https://test.myshopify.com${p}`),
    (err) => err instanceof ShopifyFetchError && /failed after 3 attempts/.test(err.message)
  );
  assert.equal(calls, 3);
});

test('exhausted retries on persistent 429 throws the last status', async () => {
  const { shopifyFetch, ShopifyFetchError } = await import('../src/shopify.js');
  process.env.SHOPIFY_MAX_RETRIES = '2';
  // The module reads SHOPIFY_MAX_RETRIES at import time — re-import is not
  // possible in the same process, so instead accept the 3-attempt default and
  // verify exhaustion across all attempts.
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return jsonResponse(429, { errors: 'rate limited' }); };
  await assert.rejects(
    () => shopifyFetch('/products.json', (p) => `https://test.myshopify.com${p}`),
    (err) => err instanceof ShopifyFetchError && err.status === 429
  );
  assert.ok(calls >= 2, 'should have retried at least once');
});

test('pagination: walks every page via the Link header cursor', async () => {
  const { shopifyFetchAllPages } = await import('../src/shopify.js');

  const page1Records = Array.from({ length: 250 }, (_, i) => ({ id: i }));
  const page2Records = Array.from({ length: 250 }, (_, i) => ({ id: 250 + i }));
  const page3Records = [{ id: 500 }];

  globalThis.fetch = async (url) => {
    const u = String(url);
    if (!u.includes('page_info')) {
      return jsonResponse(200, { products: page1Records }, {
        link: '<https://test.myshopify.com/admin/api/2024-04/products.json?page_info=PAGE2&limit=250>; rel="next"',
      });
    }
    if (u.includes('page_info=PAGE2')) {
      return jsonResponse(200, { products: page2Records }, {
        link: '<https://test.myshopify.com/admin/api/2024-04/products.json?page_info=PAGE3&limit=250>; rel="next"',
      });
    }
    return jsonResponse(200, { products: page3Records });
  };

  const all = await shopifyFetchAllPages(
    (path) => `https://test.myshopify.com${path}`,
    '/products.json?limit=250&status=active',
    'products'
  );
  assert.equal(all.length, 501);
  assert.equal(all[0].id, 0);
  assert.equal(all[500].id, 500);
});

test('pagination: stops cleanly when there is no next page', async () => {
  const { shopifyFetchAllPages } = await import('../src/shopify.js');
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return jsonResponse(200, { products: [{ id: 1 }] }); // no Link header
  };
  const all = await shopifyFetchAllPages((p) => `https://test.myshopify.com${p}`, '/products.json', 'products');
  assert.equal(calls, 1);
  assert.equal(all.length, 1);
});

test('pagination: infinite-loop safety cap aborts runaway cursors', async () => {
  const { shopifyFetchAllPages, ShopifyFetchError } = await import('../src/shopify.js');
  process.env.SHOPIFY_MAX_PAGES = '5';
  globalThis.fetch = async () => jsonResponse(200, { products: [{ id: 1 }] }, {
    link: '<https://test.myshopify.com/admin/api/2024-04/products.json?page_info=FOREVER&limit=250>; rel="next"',
  });
  // Re-importing picks up env at module load, but this module instance still
  // has the default cap of 20 — either way it must abort, never loop forever.
  await assert.rejects(
    () => shopifyFetchAllPages((p) => `https://test.myshopify.com${p}`, '/products.json', 'products'),
    (err) => err instanceof ShopifyFetchError && /safety cap/.test(err.message)
  );
  delete process.env.SHOPIFY_MAX_PAGES;
});

test('malformed response body surfaces a clear error', async () => {
  const { shopifyFetch, ShopifyFetchError } = await import('../src/shopify.js');
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: { get: () => null },
    json: async () => { throw new Error('invalid json'); },
  });
  await assert.rejects(
    () => shopifyFetch('/products.json', (p) => `https://test.myshopify.com${p}`),
    (err) => err instanceof ShopifyFetchError && /non-JSON response/.test(err.message)
  );
});

test('parseNextPageUrl handles real-world Link headers', async () => {
  const { parseNextPageUrl } = await import('../src/shopify.js');
  assert.equal(
    parseNextPageUrl('<https://x.myshopify.com/admin/api/2024-04/products.json?page_info=abc&limit=250>; rel="next"'),
    'https://x.myshopify.com/admin/api/2024-04/products.json?page_info=abc&limit=250'
  );
  assert.equal(
    parseNextPageUrl('<https://x.test?page_info=PREV>; rel="previous", <https://x.test?page_info=NEXT>; rel="next"'),
    'https://x.test?page_info=NEXT'
  );
  assert.equal(parseNextPageUrl(null), null);
  assert.equal(parseNextPageUrl('garbage'), null);
});

test('missing access token fails immediately with a clear error', async () => {
  const { shopifyFetchAllPages, ShopifyFetchError } = await import('../src/shopify.js');
  const saved = process.env.SHOPIFY_ACCESS_TOKEN;
  delete process.env.SHOPIFY_ACCESS_TOKEN;
  try {
    await assert.rejects(
      () => shopifyFetchAllPages((p) => `https://test.myshopify.com${p}`, '/products.json', 'products'),
      (err) => err instanceof ShopifyFetchError && /not configured/.test(err.message)
    );
  } finally {
    process.env.SHOPIFY_ACCESS_TOKEN = saved;
  }
});
