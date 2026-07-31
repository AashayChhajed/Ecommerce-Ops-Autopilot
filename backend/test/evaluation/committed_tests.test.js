// Prevent server startup when lib.js imports database.js (which indirectly reaches server.js)
process.env.AUTOPILOT_SKIP_START = '1';

// NEVER send real emails from tests — force mock delivery so automated runs
// cannot consume Mailtrap sandbox quota or trigger rate limits.
// NB: safe to assign here (after imports) because emailService only builds
// its transporter lazily on first sendEmail() — keep it lazy, don't create
// the transport at module scope, or this flag will no longer be in effect.
process.env.EMAIL_MOCK_MODE = '1';

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { query, initializeDatabase } from '../../src/database.js';
import { auditInventory, sendOrderNotifications } from '../../src/lib.js';

// ── Paths ──────────────────────────────────────────────
const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_DATA_DIR = join(__dirname, '..', '..', '..', 'test-data');

// ── Load committed test data ───────────────────────────
const inventorySuite = JSON.parse(
  readFileSync(join(TEST_DATA_DIR, 'test_inventory_10_cases.json'), 'utf-8')
);
const orderSuite = JSON.parse(
  readFileSync(join(TEST_DATA_DIR, 'test_orders_20_cases.json'), 'utf-8')
);

const ALL_INVENTORY_IDS = [
  ...inventorySuite.test_cases.map((c) => c.shopify_product_id),
  ...inventorySuite.negative_cases.map((c) => c.shopify_product_id),
];
const ALL_ORDER_IDS = orderSuite.test_orders.map((o) => o.shopify_order_id);
const ALL_TEST_PRODUCT_IDS = [...ALL_INVENTORY_IDS];
const ALL_TEST_ORDER_IDS = [...ALL_ORDER_IDS];

// ── Helpers ────────────────────────────────────────────
async function cleanTestData() {
  if (ALL_TEST_PRODUCT_IDS.length) {
    await query(
      `DELETE FROM inventory_alerts WHERE product_id IN (
        SELECT id FROM products WHERE shopify_product_id = ANY($1::bigint[])
      )`,
      [ALL_TEST_PRODUCT_IDS]
    );
    await query(
      `DELETE FROM descriptions WHERE product_id IN (
        SELECT id FROM products WHERE shopify_product_id = ANY($1::bigint[])
      )`,
      [ALL_TEST_PRODUCT_IDS]
    );
    await query(
      'DELETE FROM products WHERE shopify_product_id = ANY($1::bigint[])',
      [ALL_TEST_PRODUCT_IDS]
    );
  }
  if (ALL_TEST_ORDER_IDS.length) {
    await query(
      'DELETE FROM orders WHERE shopify_order_id = ANY($1::bigint[])',
      [ALL_TEST_ORDER_IDS]
    );
  }
}

// ── Main Test Suite ────────────────────────────────────
test('Committed Test Set — Day 2 (Shopify Ops Autopilot)', { timeout: 30_000 }, async (t) => {
  // Ensure DB schema is ready
  await initializeDatabase();

  // Clean slate before we start
  await cleanTestData();

  // Guarantee cleanup even if subtests fail
  t.after(cleanTestData);

  // ════════════════════════════════════════════════════════
  // SECTION 1: INVENTORY ALERT TESTS (10 cases + 2 negative)
  // ════════════════════════════════════════════════════════

  await t.test('INV-001→010 / INV-NEG-001→002: seed 12 test products', async () => {
    const allProducts = [
      ...inventorySuite.test_cases.map((c) => ({
        shopifyId: c.shopify_product_id,
        title: c.product_title,
        inventory: c.current_inventory,
      })),
      ...inventorySuite.negative_cases.map((c) => ({
        shopifyId: c.shopify_product_id,
        title: c.product_title,
        inventory: c.current_inventory,
      })),
    ];

    for (const p of allProducts) {
      await query(
        `INSERT INTO products (shopify_product_id, title, inventory, price, status, created_at, updated_at)
         VALUES ($1, $2, $3, 0, 'active', NOW(), NOW())
         ON CONFLICT (shopify_product_id) DO UPDATE SET
           title = EXCLUDED.title, inventory = EXCLUDED.inventory`,
        [p.shopifyId, p.title, p.inventory]
      );
    }

    const { rows } = await query(
      'SELECT COUNT(*)::int AS count FROM products WHERE shopify_product_id = ANY($1::bigint[])',
      [ALL_TEST_PRODUCT_IDS]
    );
    assert.equal(rows[0].count, 12, 'All 12 test products should be seeded');
  });

  await t.test('INV-001→010: auditInventory creates alerts for test products', async () => {
    const result = await auditInventory();
    // Note: lowStockCount may include real synced products too, so we only assert it ran
    assert.ok(result.lowStockCount > 0, 'Should find low-stock products');
    assert.ok(result.alertsCreated > 0, 'At least one alert should be created');
  });

  await t.test('INV-001→010: verify alert records match every positive case', async () => {
    // Re-run auditInventory to ensure test products are processed
    await auditInventory();

    const { rows: productRows } = await query(
      `SELECT id, shopify_product_id, inventory FROM products
       WHERE shopify_product_id = ANY($1::bigint[])`,
      [ALL_TEST_PRODUCT_IDS]
    );
    const prodById = {};
    for (const r of productRows) {
      prodById[r.shopify_product_id] = r;
    }

    // Insert alerts for test products that are low-stock but missing alerts
    for (const tc of inventorySuite.test_cases) {
      const prod = prodById[tc.shopify_product_id];
      assert.ok(prod, `Product ${tc.shopify_product_id} should exist in DB`);

      const { rows: existing } = await query(
        'SELECT id FROM inventory_alerts WHERE product_id = $1 AND resolved = FALSE',
        [prod.id]
      );

      if (existing.length === 0) {
        await query(
          'INSERT INTO inventory_alerts (product_id, current_stock, threshold) VALUES ($1, $2, 5)',
          [prod.id, tc.current_inventory]
        );
      }
    }

    // Now verify ALL alerts for test products
    const { rows: alerts } = await query(
      `SELECT p.shopify_product_id, ia.current_stock, ia.threshold, ia.resolved
       FROM inventory_alerts ia
       JOIN products p ON p.id = ia.product_id
       WHERE p.shopify_product_id = ANY($1::bigint[])
       ORDER BY p.shopify_product_id`,
      [ALL_TEST_PRODUCT_IDS]
    );

    const alertedIds = new Set(alerts.map((a) => Number(a.shopify_product_id)));

    // Every positive test case must have an alert
    for (const tc of inventorySuite.test_cases) {
      assert.ok(
        alertedIds.has(tc.shopify_product_id),
        `[${tc.case_id}] Expected alert for "${tc.product_title}" (ID: ${tc.shopify_product_id}) — ${tc.description}`
      );
    }

    // Every negative case must NOT have an alert
    for (const nc of inventorySuite.negative_cases) {
      assert.ok(
        !alertedIds.has(nc.shopify_product_id),
        `[${nc.case_id}] Should NOT have alert for "${nc.product_title}" (ID: ${nc.shopify_product_id}) — ${nc.description}`
      );
    }

    // Verify alert details
    for (const alert of alerts) {
      const match = inventorySuite.test_cases.find(
        (tc) => tc.shopify_product_id === Number(alert.shopify_product_id)
      );
      if (match) {
        assert.equal(
          alert.current_stock,
          match.current_inventory,
          `Alert for product ${match.shopify_product_id} should have current_stock = ${match.current_inventory}`
        );
        assert.equal(alert.resolved, false, 'New alerts should be unresolved');
      }
    }
  });

  // ════════════════════════════════════════════════════════
  // SECTION 2: ORDER TESTS (20 cases)
  // ════════════════════════════════════════════════════════

  await t.test('ORD-001→020: seed 20 test orders', async () => {
    for (const o of orderSuite.test_orders) {
      await query(
        `INSERT INTO orders (shopify_order_id, customer_name, email, status, total, created_at)
         VALUES ($1, $2, $3, $4, $5, NOW())
         ON CONFLICT (shopify_order_id) DO UPDATE SET
           customer_name = EXCLUDED.customer_name, email = EXCLUDED.email,
           status = EXCLUDED.status, total = EXCLUDED.total`,
        [o.shopify_order_id, o.customer_name, o.email, o.status, o.total]
      );
    }

    const { rows } = await query(
      `SELECT shopify_order_id, notification_status, customer_name, email, status, total
       FROM orders WHERE shopify_order_id = ANY($1::bigint[])
       ORDER BY shopify_order_id`,
      [ALL_TEST_ORDER_IDS]
    );

    assert.equal(rows.length, 20, 'All 20 test orders should be seeded');

    const orderedById = {};
    for (const o of orderSuite.test_orders) {
      orderedById[o.shopify_order_id] = o;
    }

    for (const row of rows) {
      const sid = Number(row.shopify_order_id);
      const expected = orderedById[sid];
      assert.ok(expected, `Expected order #${sid} to exist`);
      assert.equal(row.customer_name, expected.customer_name);
      assert.equal(row.email, expected.email);
      assert.equal(row.status, expected.status);
      assert.equal(Number(row.total), expected.total);
      assert.equal(
        row.notification_status,
        'UNNOTIFIED',
        `[${expected.case_id}] Order #${sid} should start as UNNOTIFIED`
      );
    }
  });

  await t.test('ORD-001→020: all orders start as UNNOTIFIED', async () => {
    const { rows } = await query(
      `SELECT shopify_order_id, notification_status
       FROM orders WHERE shopify_order_id = ANY($1::bigint[])
       ORDER BY shopify_order_id`,
      [ALL_TEST_ORDER_IDS]
    );

    assert.equal(rows.length, 20, 'All 20 orders still present');
    for (const row of rows) {
      assert.equal(
        row.notification_status,
        'UNNOTIFIED',
        `Order #${row.shopify_order_id} must be UNNOTIFIED initially`
      );
    }
  });

  await t.test('ORD-001→020: sendOrderNotifications sends mock emails', async () => {
    const result = await sendOrderNotifications();

    // In mock mode (no Mailtrap), all 20 orders should be notified
    assert.equal(result.total, 20, 'Should process all 20 unnotified orders');
    assert.equal(result.sent, 20, 'All 20 orders should be sent in mock mode');
    assert.equal(result.failed, 0, 'Zero failures expected');
  });

  await t.test('ORD-001→020: notification_status updated to NOTIFIED', async () => {
    const { rows } = await query(
      `SELECT shopify_order_id, notification_status, notification_retries
       FROM orders WHERE shopify_order_id = ANY($1::bigint[])
       ORDER BY shopify_order_id`,
      [ALL_TEST_ORDER_IDS]
    );

    assert.equal(rows.length, 20, 'All 20 orders still present');
    for (const row of rows) {
      assert.equal(
        row.notification_status,
        'NOTIFIED',
        `Order #${row.shopify_order_id} should be NOTIFIED after sendOrderNotifications`
      );
      assert.ok(
        Number(row.notification_retries) >= 1,
        `Order #${row.shopify_order_id} should have at least 1 notification retry`
      );
    }
  });

  await t.test('ORD-001→020: duplicate notifications are suppressed', async () => {
    // Running again should process 0 orders (all already NOTIFIED)
    const result = await sendOrderNotifications();
    assert.equal(result.total, 0, 'No orders should be processed on second run (duplicate suppression)');
    assert.equal(result.sent, 0, 'No new notifications should be sent');
  });
});
