// Phase 2: deterministic pagination.
// Records with IDENTICAL timestamps must page back identically: no duplicated
// rows across pages, no skipped rows, stable order run-to-run (id tiebreak).
process.env.AUTOPILOT_SKIP_START = '1';
process.env.EMAIL_MOCK_MODE = '1';
process.env.NODE_ENV = 'test';

import test from 'node:test';
import assert from 'node:assert/strict';
import { initializeDatabase, query, closeDatabase } from '../src/database.js';

// NB: same bootstrap approach as api.e2e.test.js — server.js must be imported
// dynamically so AUTOPILOT_SKIP_START is already in effect.
const { server } = await import('../src/server.js');

const LOG_MARKER = 'PG-TIEBREAK-LOG-2026';
const PRODUCT_MARKER = 'PG-TIEBREAK-PRODUCT-2026';
const IDENTICAL_TS = '2026-03-01T12:00:00.000Z';
let baseUrl;

async function api(path) {
  const res = await fetch(`${baseUrl}${path}`);
  const body = await res.json().catch(() => null);
  return { status: res.status, json: body };
}

async function cleanup() {
  await query(`DELETE FROM activity_logs WHERE type = $1`, [LOG_MARKER]);
  await query(`DELETE FROM products WHERE title LIKE $1`, [`${PRODUCT_MARKER}%`]);
}

test('Pagination determinism — identical timestamps page stably', { timeout: 60_000 }, async (t) => {
  await initializeDatabase();
  await cleanup();

  await new Promise((resolve) => server.listen(0, () => resolve()));
  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;

  t.after(() => new Promise((resolve) => server.close(resolve)));
  t.after(cleanup);
  t.after(() => closeDatabase());

  // Seed 5 activity-log rows that share ONE timestamp — without an id
  // tiebreaker their relative order across LIMIT/OFFSET pages is up to the
  // planner and rows can repeat or vanish between pages.
  const logIds = [];
  for (let i = 0; i < 5; i += 1) {
    const { rows } = await query(
      `INSERT INTO activity_logs (type, message, status, created_at)
       VALUES ($1, $2, 'INFO', $3) RETURNING id`,
      [LOG_MARKER, `tiebreak row ${i}`, IDENTICAL_TS]
    );
    logIds.push(Number(rows[0].id));
  }

  await t.test('activity logs: identical created_at → pages partition exactly, order stable', async () => {
    const expected = [...logIds].sort((a, b) => b - a); // id DESC within the tie

    const pages = [];
    for (const page of [1, 2, 3]) {
      const r = await api(`/api/activity-logs?type=${LOG_MARKER}&page=${page}&limit=2`);
      assert.equal(r.status, 200);
      assert.equal(r.json.pagination.total, 5);
      pages.push(...r.json.data.map((row) => Number(row.id)));
    }

    assert.equal(pages.length, 5, 'no row skipped or duplicated across pages');
    assert.equal(new Set(pages).size, 5, 'no duplicate ids across page boundaries');
    assert.deepEqual(pages, expected, 'identical timestamps ordered by id DESC');

    // Run-to-run stability: the exact same request returns the exact same page.
    const again = await api(`/api/activity-logs?type=${LOG_MARKER}&page=1&limit=2`);
    const first = await api(`/api/activity-logs?type=${LOG_MARKER}&page=1&limit=2`);
    assert.deepEqual(
      again.json.data.map((r) => r.id),
      first.json.data.map((r) => r.id),
      'repeat requests return an identical page'
    );
  });

  // Same guarantee for products, whose pagination orders on updated_at.
  const productIds = [];
  for (let i = 0; i < 4; i += 1) {
    const { rows } = await query(
      `INSERT INTO products (shopify_product_id, title, inventory, price, status, created_at, updated_at)
       VALUES ($1, $2, 10, 9.99, 'active', $3, $3) RETURNING id`,
      [990000 + i, `${PRODUCT_MARKER} ${i}`, IDENTICAL_TS]
    );
    productIds.push(Number(rows[0].id));
  }

  await t.test('products: identical updated_at → pages partition exactly, order stable', async () => {
    const expected = [...productIds].sort((a, b) => b - a); // id DESC within the tie

    const seen = [];
    for (const page of [1, 2]) {
      const r = await api(`/api/products?search=${PRODUCT_MARKER}&page=${page}&limit=2`);
      assert.equal(r.status, 200);
      assert.equal(r.json.pagination.total, 4);
      seen.push(...r.json.data.map((row) => Number(row.id)));
    }

    assert.equal(seen.length, 4, 'no product skipped or duplicated across pages');
    assert.equal(new Set(seen).size, 4, 'no duplicate ids across page boundaries');
    assert.deepEqual(seen, expected, 'identical updated_at ordered by id DESC');
  });
});
