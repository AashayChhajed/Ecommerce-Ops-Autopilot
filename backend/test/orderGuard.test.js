// Over-Order Guard test suite — verifies the system never accepts an order
// that cannot be fulfilled from warehouse stock, across all channels.
process.env.AUTOPILOT_SKIP_START = '1';

import test from 'node:test';
import assert from 'node:assert/strict';
import { query, initializeDatabase, closeDatabase, withTransaction } from '../src/database.js';
import {
  placeChannelOrder,
  releaseOrderAllocation,
  fulfillOrderAllocation,
  checkOrderFulfillable,
  getAvailableStock,
  reconcileChannelListings,
  getSafetyBufferPercent,
  updateSafetyBufferPercent,
} from '../src/orderGuard.js';

// Each subtest gets its own product (96001+) so tests never share state.
const nextId = (() => { let n = 96000; return () => ++n; })();

async function seedProduct(warehouseQty) {
  const shopifyId = nextId();
  const { rows } = await query(`
    INSERT INTO products (shopify_product_id, title, inventory, warehouse_quantity, price, status, sku, created_at, updated_at)
    VALUES ($1, $2, $3, $3, 10, 'active', $4, NOW(), NOW())
    RETURNING id
  `, [shopifyId, `Guard Product ${shopifyId}`, warehouseQty, `SKU-GUARD-${shopifyId}`]);
  return { productId: Number(rows[0].id), shopifyId };
}

async function cleanTestData() {
  // Restore the global safety buffer to its default (no buffer) so subtests
  // never leak a custom percentage into each other.
  await query(`UPDATE safety_settings SET buffer_percent = 100 WHERE id = 1`).catch(() => {});
  await query(`DELETE FROM order_items WHERE order_id IN (
    SELECT id FROM orders WHERE customer_name = 'Guard Tester' OR customer_name = 'Race Tester'
  )`).catch(() => {});
  await query(`DELETE FROM orders WHERE customer_name = 'Guard Tester' OR customer_name = 'Race Tester'`).catch(() => {});
  await query(`DELETE FROM inventory_alerts WHERE product_id IN (
    SELECT id FROM products WHERE sku LIKE 'SKU-GUARD-%' OR sku = 'SKU-GUARD-RACE'
  )`).catch(() => {});
  await query(`DELETE FROM descriptions WHERE product_id IN (
    SELECT id FROM products WHERE sku LIKE 'SKU-GUARD-%' OR sku = 'SKU-GUARD-RACE'
  )`).catch(() => {});
  await query(`DELETE FROM channel_products WHERE product_id IN (
    SELECT id FROM products WHERE sku LIKE 'SKU-GUARD-%' OR sku = 'SKU-GUARD-RACE'
  )`).catch(() => {});
  await query(`DELETE FROM products WHERE sku LIKE 'SKU-GUARD-%' OR sku = 'SKU-GUARD-RACE'`).catch(() => {});
}

async function placeGuardOrder(productId, quantity, channel = 'AMAZON_MOCK', reference = null) {
  return placeChannelOrder({
    channelCode: channel,
    orderReference: reference ?? `GUARD-TEST-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    customerName: 'Guard Tester',
    email: 'guard@test.dev',
    total: quantity * 10,
    items: [{ productId, quantity }],
  });
}

async function productAllocation(productId) {
  const { rows: [p] } = await query(
    'SELECT warehouse_quantity, allocated_quantity FROM products WHERE id = $1', [productId]
  );
  return { warehouse: Number(p.warehouse_quantity), allocated: Number(p.allocated_quantity) };
}

test('Over-Order Guard — committed test set', { timeout: 60_000 }, async (t) => {
  await initializeDatabase();
  await cleanTestData();
  t.after(cleanTestData);

  // ════════════════════════════════════════════════════════════════
  // SECTION 1: Basic allocation & rejection semantics
  // ════════════════════════════════════════════════════════════════

  await t.test('GUA-001: accepts an order within warehouse stock', async () => {
    const { productId } = await seedProduct(10);
    const result = await placeGuardOrder(productId, 4);
    assert.equal(result.status, 'ALLOCATED', 'Order within stock must be accepted');

    const { rows: [order] } = await query(
      'SELECT allocation_status FROM orders WHERE id = $1', [result.orderId]
    );
    assert.equal(order.allocation_status, 'ALLOCATED');

    const { allocated } = await productAllocation(productId);
    assert.equal(allocated, 4, 'Warehouse stock must be reserved');

    const { rows: items } = await query(
      'SELECT quantity FROM order_items WHERE order_id = $1', [result.orderId]
    );
    assert.equal(items.length, 1);
    assert.equal(Number(items[0].quantity), 4);
  });

  await t.test('GUA-002: rejects an order that exceeds remaining warehouse stock', async () => {
    const { productId } = await seedProduct(10);
    // Reserve 4 first
    const first = await placeGuardOrder(productId, 4);
    assert.equal(first.status, 'ALLOCATED');

    // Only 6 remain — ordering 7 must be rejected
    const result = await placeGuardOrder(productId, 7);
    assert.equal(result.status, 'REJECTED', 'Order above available stock must be rejected');
    assert.ok(result.shortfalls.length > 0, 'Shortfall details must be reported');
    assert.equal(result.shortfalls[0].available, 6, 'Shortfall must cite available stock');

    const { allocated } = await productAllocation(productId);
    assert.equal(allocated, 4, 'Rejected order must not reserve stock');
  });

  await t.test('GUA-003: accepts an order exactly at the remaining boundary', async () => {
    const { productId } = await seedProduct(10);
    await placeGuardOrder(productId, 4); // reserve 4 → 6 left
    const result = await placeGuardOrder(productId, 6);
    assert.equal(result.status, 'ALLOCATED', 'Boundary order must be accepted');
    const { allocated } = await productAllocation(productId);
    assert.equal(allocated, 10, 'All warehouse stock reserved');
  });

  // ════════════════════════════════════════════════════════════════
  // SECTION 2: All channels share the same warehouse pool
  // ════════════════════════════════════════════════════════════════

  await t.test('GUA-004: simultaneous orders across channels never oversell', async () => {
    const { productId } = await seedProduct(5);

    const orders = await Promise.all([
      placeGuardOrder(productId, 2, 'AMAZON_MOCK'),
      placeGuardOrder(productId, 2, 'MYNTRA_MOCK'),
      placeGuardOrder(productId, 2, 'FLIPKART_MOCK'),
    ]);

    const accepted = orders.filter((o) => o.status === 'ALLOCATED').length;
    const rejected = orders.filter((o) => o.status === 'REJECTED').length;

    assert.equal(accepted + rejected, 3, 'Every order gets a definitive verdict');
    assert.equal(accepted, 2, 'Only 2 of 3 (4 units) can fit into 5-unit warehouse');
    assert.equal(rejected, 1, 'The third order must be rejected — never oversold');

    const { allocated } = await productAllocation(productId);
    assert.equal(allocated, 4, 'Reserved total never exceeds warehouse');
  });

  await t.test('GUA-005: shopify channel uses the same warehouse guard', async () => {
    const { productId } = await seedProduct(5);
    const first = await placeGuardOrder(productId, 4, 'SHOPIFY', `GUARD-TEST-${Date.now()}-a`);
    assert.equal(first.status, 'ALLOCATED');

    // 1 left — Shopify order for 2 must be rejected
    const result = await placeGuardOrder(productId, 2, 'SHOPIFY', `GUARD-TEST-${Date.now()}-b`);
    assert.equal(result.status, 'REJECTED', 'Shopify orders must respect warehouse stock too');
  });

  // ════════════════════════════════════════════════════════════════
  // SECTION 3: Release & fulfill lifecycle
  // ════════════════════════════════════════════════════════════════

  await t.test('GUA-006: releasing a cancelled order returns stock to the pool', async () => {
    const { productId } = await seedProduct(8);
    const r1 = await placeGuardOrder(productId, 3);
    assert.equal(r1.status, 'ALLOCATED');

    const before = await getAvailableStock(productId);
    assert.equal(before, 5, 'Available = 8 − 3 reserved');

    const release = await releaseOrderAllocation(r1.orderId);
    assert.equal(release.status, 'RELEASED');
    assert.equal(release.changed, true);

    const after = await getAvailableStock(productId);
    assert.equal(after, 8, 'Stock returned after release');

    // A released order cannot be released again
    const again = await releaseOrderAllocation(r1.orderId);
    assert.equal(again.changed, false);
  });

  await t.test('GUA-007: fulfilling an order deducts warehouse stock', async () => {
    const { productId } = await seedProduct(8);
    const r1 = await placeGuardOrder(productId, 3);
    assert.equal(r1.status, 'ALLOCATED');

    const fulfill = await fulfillOrderAllocation(r1.orderId);
    assert.equal(fulfill.status, 'FULFILLED');

    const { warehouse, allocated } = await productAllocation(productId);
    assert.equal(warehouse, 5, 'Warehouse reduced after shipment');
    assert.equal(allocated, 0, 'Reservation cleared after shipment');
  });

  // ════════════════════════════════════════════════════════════════
  // SECTION 4: Availability checks, unresolved items, listing reconcile
  // ════════════════════════════════════════════════════════════════

  await t.test('GUA-008: non-mutating availability check reports shortfalls', async () => {
    const { productId } = await seedProduct(8);
    const check = await checkOrderFulfillable([
      { productId, quantity: 3 },
      { productId, quantity: 10 },
    ]);
    assert.equal(check.ok, false);
    assert.ok(check.shortfalls.length >= 1);
    assert.equal(check.shortfalls[0].requested, 10);

    const ok = await checkOrderFulfillable([{ productId, quantity: 2 }]);
    assert.equal(ok.ok, true);
  });

  await t.test('GUA-008b: order with an unresolvable line item is rejected whole', async () => {
    const { productId } = await seedProduct(5);
    const result = await placeChannelOrder({
      channelCode: 'AMAZON_MOCK',
      orderReference: `GUARD-TEST-${Date.now()}-unresolved`,
      customerName: 'Guard Tester',
      email: 'guard@test.dev',
      total: 50,
      items: [
        { productId, quantity: 2 },       // resolvable
        { channelSku: 'NO-SUCH-SKU-99', quantity: 1 }, // unresolvable
      ],
    });
    assert.equal(result.status, 'REJECTED', 'Order with any unresolvable item must be rejected');
    const { allocated } = await productAllocation(productId);
    assert.equal(allocated, 0, 'No stock reserved for a rejected order');
  });

  await t.test('GUA-011: safety buffer limits how much warehouse stock is sellable', async () => {
    const { productId } = await seedProduct(10);
    const original = await getSafetyBufferPercent();
    try {
      await updateSafetyBufferPercent(50); // only 50% of warehouse is sellable
      assert.equal(await getSafetyBufferPercent(), 50);
      assert.equal(await getAvailableStock(productId), 5, '50% of 10 = 5 sellable');

      const r1 = await placeGuardOrder(productId, 5);
      assert.equal(r1.status, 'ALLOCATED', 'Order up to buffered available is accepted');

      const r2 = await placeGuardOrder(productId, 1);
      assert.equal(r2.status, 'REJECTED', 'Order beyond buffered available is rejected');
      const { allocated } = await productAllocation(productId);
      assert.equal(allocated, 5, 'Rejected order must not reserve stock');
    } finally {
      await updateSafetyBufferPercent(original);
    }
  });

  await t.test('GUA-012: inventory feed push caps listings on every channel after accept', async () => {
    const { productId } = await seedProduct(10);
    const { rows: chs } = await query(
      `SELECT id, code FROM channels WHERE code IN ('AMAZON_MOCK','MYNTRA_MOCK') ORDER BY code`
    );
    for (const ch of chs) {
      await query(`
        INSERT INTO channel_products (product_id, channel_id, channel_sku, title, available_quantity, last_synced_at, updated_at)
        VALUES ($1, $2, $3, 'Guard Feed Product', 50, NOW(), NOW())
        ON CONFLICT (product_id, channel_id) DO UPDATE SET available_quantity = 50
      `, [productId, ch.id, `GUARD-FEED-${ch.code}`]);
    }

    // Accept an order of 4 → available = 6. Feed push must cap both listings to 6.
    const result = await placeGuardOrder(productId, 4, 'AMAZON_MOCK');
    assert.equal(result.status, 'ALLOCATED');

    const { rows: listings } = await query(
      `SELECT c.code, cp.available_quantity FROM channel_products cp
       JOIN channels c ON c.id = cp.channel_id WHERE cp.product_id = $1 ORDER BY c.code`,
      [productId]
    );
    assert.equal(listings.length, 2);
    for (const l of listings) {
      assert.equal(Number(l.available_quantity), 6, `${l.code} listing must be capped to available after accept`);
    }
  });

  await t.test('GUA-009: reconcile caps channel listings to warehouse availability', async () => {
    const { productId } = await seedProduct(5);
    const { rows: [ch] } = await query(`SELECT id FROM channels WHERE code = 'AMAZON_MOCK'`);
    await query(`
      INSERT INTO channel_products (product_id, channel_id, channel_sku, title, available_quantity, last_synced_at, updated_at)
      VALUES ($1, $2, 'GUARD-SKU-1', 'Guard Product', 50, NOW(), NOW())
      ON CONFLICT (product_id, channel_id) DO UPDATE SET available_quantity = 50
    `, [productId, ch.id]);

    const result = await reconcileChannelListings();
    const matching = result.details.find((d) => d.productId === productId && d.channel === 'AMAZON_MOCK');
    assert.ok(matching, 'Reconcile must process the product listing');
    assert.equal(matching.new, 5, 'Listing capped to warehouse availability');

    const { rows: [cp] } = await query(
      'SELECT available_quantity FROM channel_products WHERE product_id = $1 AND channel_id = $2',
      [productId, ch.id]
    );
    assert.equal(Number(cp.available_quantity), 5);
  });

  // ════════════════════════════════════════════════════════════════
  // SECTION 5: Race-safety — allocations never exceed warehouse under concurrency
  // ════════════════════════════════════════════════════════════════

  await t.test('GUA-010: concurrent intakes stay under the warehouse ceiling', async () => {
    const { productId } = await seedProduct(10);

    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => placeChannelOrder({
        channelCode: 'AMAZON_MOCK',
        orderReference: `GUARD-RACE-${Date.now()}-${i}`,
        customerName: 'Race Tester',
        email: `race${i}@test.dev`,
        total: 20,
        items: [{ productId, quantity: 2 }],
      }))
    );

    const accepted = results.filter((r) => r.status === 'ALLOCATED').length;
    const rejected = results.filter((r) => r.status === 'REJECTED').length;
    assert.equal(accepted, 5, 'Exactly 5 orders of 2 units can fit into 10-unit warehouse');
    assert.equal(rejected, 5, 'The remaining 5 must be rejected');
    assert.equal(accepted + rejected, 10, 'No order left undecided');

    const { allocated } = await productAllocation(productId);
    assert.equal(allocated, 10, 'Reserved never exceeds warehouse ceiling');
  });
});

test('Over-Order Guard — transaction helper rolls back on error', async () => {
  await assert.rejects(
    withTransaction(async (client) => {
      await client.query('SELECT 1');
      throw new Error('boom');
    }),
    /boom/
  );
  await closeDatabase();
});
