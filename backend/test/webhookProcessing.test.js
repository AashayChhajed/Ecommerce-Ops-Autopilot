// Phase 3 — webhook processing: persistent state machine, retries, and the
// order/product/inventory domain operations. Events are inserted directly and
// driven through the worker by id, so parallel test files can never interfere.
process.env.AUTOPILOT_SKIP_START = '1';
process.env.EMAIL_MOCK_MODE = '1';
process.env.NODE_ENV = 'test';
process.env.SHOPIFY_WEBHOOK_SECRET = 'wh-processing-secret';
process.env.AUTOPILOT_WEBHOOK_INLINE_PROCESSING = '0';
process.env.WEBHOOK_MAX_RETRIES = '2';
process.env.WEBHOOK_RETRY_BASE_MS = '50';
process.env.WEBHOOK_RETRY_MAX_MS = '200';
process.env.WEBHOOK_MAX_EVENTS_PER_RUN = '50';

import test from 'node:test';
import assert from 'node:assert/strict';
import { initializeDatabase, query, closeDatabase } from '../src/database.js';

// Dynamic import so the env above is already in effect (config is read at call
// time, but this keeps the file consistent with the Phase 2 test pattern).
const { processWebhookEventById, processPendingWebhookEvents, webhookBackoffMs, getWebhookConfig, WebhookPermanentError } =
  await import('../src/webhooks.js');
const { applyShopifyOrder, upsertProductsFromShopify } = await import('../src/shopifyDomain.js');

const EVENT_PREFIX = 'WH-PROC-';
const PRODUCT_BASE = 981000100; // reserved for THIS file: 981000100–981000199
const PRODUCT_CEIL = 981000199;
const ORDER_BASE = 881000000;
const ORDER_CEIL = 881000199;
const INV_ITEM_BASE = 777000000;

let pidCounter = 120; // keeps generated ids inside 981000100–981000199
let oidCounter = 120;
const pid = () => PRODUCT_BASE + pidCounter++;
const oid = () => ORDER_BASE + oidCounter++;

function evtId(tag) {
  return `${EVENT_PREFIX}${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

async function enqueue({ eventId, topic, payload, status = 'RECEIVED', attempts = 0, nextAttemptAt = null }) {
  const { rows } = await query(`
    INSERT INTO webhook_events (event_id, topic, shop_domain, payload, status, attempts, next_attempt_at)
    VALUES ($1, $2, 'test-shop.myshopify.com', $3::jsonb, $4, $5, $6)
    RETURNING id
  `, [eventId, topic, JSON.stringify(payload), status, attempts, nextAttemptAt]);
  return Number(rows[0].id);
}

async function eventRow(id) {
  const { rows } = await query('SELECT * FROM webhook_events WHERE id = $1', [id]);
  return rows[0];
}

async function seedProduct({ shopifyId, inventory = 10, warehouse = 10, sku = null, inventoryItemId = null }) {
  const { rows } = await query(`
    INSERT INTO products (shopify_product_id, title, inventory, warehouse_quantity, price, status, sku, shopify_inventory_item_id, shopify_updated_at, created_at, updated_at)
    VALUES ($1, $2, $3, $4, 10, 'active', $5, $6, NOW(), NOW(), NOW())
    ON CONFLICT (shopify_product_id) DO UPDATE SET
      inventory = EXCLUDED.inventory, warehouse_quantity = EXCLUDED.warehouse_quantity,
      shopify_inventory_item_id = EXCLUDED.shopify_inventory_item_id, updated_at = NOW()
    RETURNING id
  `, [shopifyId, `WH Proc Product ${shopifyId}`, inventory, warehouse, sku, inventoryItemId]);
  return { productId: Number(rows[0].id), shopifyId };
}

async function productAllocation(productId) {
  const { rows: [p] } = await query(
    'SELECT warehouse_quantity, allocated_quantity FROM products WHERE id = $1', [productId]
  );
  return { warehouse: Number(p.warehouse_quantity), allocated: Number(p.allocated_quantity) };
}

async function cleanup() {
  await query(`DELETE FROM webhook_events WHERE event_id LIKE $1`, [`${EVENT_PREFIX}%`]).catch(() => {});
  await query(`DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE shopify_order_id BETWEEN $1 AND $2)`, [ORDER_BASE, ORDER_CEIL]).catch(() => {});
  await query(`DELETE FROM orders WHERE shopify_order_id BETWEEN $1 AND $2`, [ORDER_BASE, ORDER_CEIL]).catch(() => {});
  await query(`DELETE FROM inventory_alerts WHERE product_id IN (SELECT id FROM products WHERE shopify_product_id BETWEEN $1 AND $2)`, [PRODUCT_BASE, PRODUCT_CEIL]).catch(() => {});
  await query(`DELETE FROM descriptions WHERE product_id IN (SELECT id FROM products WHERE shopify_product_id BETWEEN $1 AND $2)`, [PRODUCT_BASE, PRODUCT_CEIL]).catch(() => {});
  await query(`DELETE FROM channel_products WHERE product_id IN (SELECT id FROM products WHERE shopify_product_id BETWEEN $1 AND $2)`, [PRODUCT_BASE, PRODUCT_CEIL]).catch(() => {});
  await query(`DELETE FROM products WHERE shopify_product_id BETWEEN $1 AND $2`, [PRODUCT_BASE, PRODUCT_CEIL]).catch(() => {});
  await query(`UPDATE safety_settings SET buffer_percent = 100 WHERE id = 1`).catch(() => {});
}

test('Webhook processing — state machine, retries, domain ops', { timeout: 90_000 }, async (t) => {
  await initializeDatabase();
  await cleanup();
  t.after(cleanup);
  t.after(() => closeDatabase());

  // ════════════════════════════════════════════════════════════════
  // SECTION 1: State machine + retries
  // ════════════════════════════════════════════════════════════════

  await t.test('RECEIVED → PROCESSING → PROCESSED with timestamps and attempt count', async () => {
    const id = await enqueue({ eventId: evtId('state'), topic: 'products/create', payload: { id: pid(), title: 'State' } });
    let observedDuringProcessing = null;
    await processWebhookEventById(id, async () => {
      const { rows } = await query('SELECT status FROM webhook_events WHERE id = $1', [id]);
      observedDuringProcessing = rows[0].status;
    });
    assert.equal(observedDuringProcessing, 'PROCESSING', 'the row is PROCESSING while the work runs');

    const row = await eventRow(id);
    assert.equal(row.status, 'PROCESSED');
    assert.ok(row.processed_at, 'processed_at is stamped');
    assert.equal(Number(row.attempts), 1);
    assert.equal(row.last_error, null);
  });

  await t.test('transient failure → RETRYING with bounded backoff, then succeeds', async () => {
    const id = await enqueue({ eventId: evtId('transient'), topic: 'products/create', payload: { id: pid(), title: 'Transient' } });
    const outcome = await processWebhookEventById(id, async () => { throw new Error('temporary db blip'); });
    assert.equal(outcome.status, 'RETRYING');

    let row = await eventRow(id);
    assert.equal(row.status, 'RETRYING');
    assert.equal(Number(row.attempts), 1);
    assert.equal(row.last_error, 'temporary db blip');
    assert.ok(row.next_attempt_at, 'next_attempt_at is scheduled');
    assert.equal(row.processed_at, null);

    // Force the retry due and let it succeed.
    await query(`UPDATE webhook_events SET next_attempt_at = NOW() - INTERVAL '1 second' WHERE id = $1`, [id]);
    const second = await processWebhookEventById(id, async () => {});
    assert.equal(second.status, 'PROCESSED');

    row = await eventRow(id);
    assert.equal(row.status, 'PROCESSED');
    assert.equal(Number(row.attempts), 2);
    assert.equal(row.last_error, null, 'error cleared after success');
    assert.equal(row.next_attempt_at, null);
    assert.ok(row.processed_at);
  });

  await t.test('permanent failure → FAILED immediately, payload retained, never retried', async () => {
    const payload = { id: pid(), title: 'Permanent' };
    const id = await enqueue({ eventId: evtId('permanent'), topic: 'products/create', payload });
    const outcome = await processWebhookEventById(id, async () => {
      throw new WebhookPermanentError('invalid payload shape');
    });
    assert.equal(outcome.status, 'FAILED');

    let row = await eventRow(id);
    assert.equal(row.status, 'FAILED');
    assert.equal(Number(row.attempts), 1);
    assert.equal(row.next_attempt_at, null, 'no retry scheduled');
    assert.equal(row.last_error, 'invalid payload shape');
    assert.ok(row.payload, 'the payload is retained, never discarded');

    const again = await processWebhookEventById(id);
    assert.equal(again.status, 'SKIPPED', 'a FAILED event is not claimable');
    row = await eventRow(id);
    assert.equal(Number(row.attempts), 1, 'no further attempts');
  });

  await t.test('retry exhaustion → FAILED after WEBHOOK_MAX_RETRIES (bounded)', async () => {
    const id = await enqueue({
      eventId: evtId('exhaust'),
      topic: 'products/create',
      payload: { id: pid(), title: 'Exhaust' },
      status: 'RETRYING',
      attempts: 1, // next failure hits the ceiling of 2
      nextAttemptAt: new Date(Date.now() - 1000),
    });
    const outcome = await processWebhookEventById(id, async () => { throw new Error('still failing'); });
    assert.equal(outcome.status, 'FAILED');

    const row = await eventRow(id);
    assert.equal(row.status, 'FAILED');
    assert.equal(Number(row.attempts), 2);
    assert.equal(row.last_error, 'still failing');
  });

  await t.test('concurrent processing of one event runs the work exactly once', async () => {
    const id = await enqueue({ eventId: evtId('concurrent'), topic: 'products/create', payload: { id: pid(), title: 'Concurrent' } });
    let calls = 0;
    const dispatch = async () => { calls += 1; await new Promise((r) => setTimeout(r, 30)); };
    const results = await Promise.all([
      processWebhookEventById(id, dispatch),
      processWebhookEventById(id, dispatch),
    ]);
    assert.equal(calls, 1, 'the atomic claim prevents double processing');
    assert.equal(results.filter((r) => r.status === 'SKIPPED').length, 1);
    assert.equal((await eventRow(id)).status, 'PROCESSED');
  });

  await t.test('the pending worker drains due RECEIVED events', async () => {
    const id = await enqueue({ eventId: evtId('drain'), topic: 'products/create', payload: { id: pid(), title: 'Drain' } });
    const result = await processPendingWebhookEvents();
    assert.ok(result.total >= 1);
    assert.ok(result.processed >= 1);
    assert.equal((await eventRow(id)).status, 'PROCESSED');
  });

  await t.test('webhookBackoffMs is bounded exponential with jitter', () => {
    const { retryBaseMs, retryMaxMs } = getWebhookConfig();
    assert.ok(retryBaseMs >= 250, 'backoff base has a sane floor');
    assert.ok(retryMaxMs >= retryBaseMs, 'ceiling is at least the base');
    for (let attempt = 1; attempt <= 10; attempt += 1) {
      const ms = webhookBackoffMs(attempt);
      assert.ok(ms >= 0, 'non-negative');
      assert.ok(ms <= retryMaxMs, `capped at WEBHOOK_RETRY_MAX_MS (got ${ms})`);
    }
    // Never grows unbounded: the largest step is still capped.
    assert.ok(webhookBackoffMs(50) <= retryMaxMs);
  });

  // ════════════════════════════════════════════════════════════════
  // SECTION 2: Orders
  // ════════════════════════════════════════════════════════════════

  let productId;
  let productShopifyId;
  let orderShopifyId;
  let orderPayload;

  await t.test('orders/create allocates warehouse stock through the existing guard', async () => {
    productShopifyId = pid();
    ({ productId } = await seedProduct({ shopifyId: productShopifyId, inventory: 10, warehouse: 10, sku: 'SKU-WH-ORD-A' }));
    orderShopifyId = oid();
    orderPayload = {
      id: orderShopifyId,
      financial_status: 'paid',
      total_price: '30.00',
      // Deliberately no email: the notification worker must never claim these
      // test orders, so this suite can run in parallel with notifications.test.js
      // without perturbing its global send counts.
      email: null,
      created_at: '2026-09-01T00:00:00Z',
      updated_at: '2026-09-01T00:00:00Z',
      customer: { first_name: 'Web', last_name: 'Hook' },
      line_items: [{ product_id: productShopifyId, sku: 'SKU-WH-ORD-A', quantity: 3 }],
    };

    const id = await enqueue({ eventId: evtId('order-create'), topic: 'orders/create', payload: orderPayload });
    const outcome = await processWebhookEventById(id);
    assert.equal(outcome.status, 'PROCESSED');

    const { rows: [order] } = await query('SELECT * FROM orders WHERE shopify_order_id = $1', [orderShopifyId]);
    assert.ok(order, 'order row created');
    assert.equal(order.allocation_status, 'ALLOCATED');
    assert.equal(order.channel_code, 'SHOPIFY');
    assert.equal(Number(order.total), 30);
    assert.equal(order.customer_name, 'Web Hook');

    const { rows: items } = await query('SELECT quantity FROM order_items WHERE order_id = $1', [order.id]);
    assert.equal(items.length, 1);
    assert.equal(Number(items[0].quantity), 3);

    const alloc = await productAllocation(productId);
    assert.equal(alloc.allocated, 3, 'warehouse stock reserved exactly once');
  });

  await t.test('duplicate deliveries do not duplicate the business operation', async () => {
    const before = await productAllocation(productId);

    // (a) The same event_id is collapsed by the UNIQUE constraint at persist time.
    const dupEventId = evtId('order-dup-eventid');
    await enqueue({ eventId: dupEventId, topic: 'orders/create', payload: orderPayload });
    const { rowCount } = await query(`
      INSERT INTO webhook_events (event_id, topic, shop_domain, payload, status)
      VALUES ($1, 'orders/create', 'test-shop.myshopify.com', $2::jsonb, 'RECEIVED')
      ON CONFLICT (event_id) DO NOTHING
    `, [dupEventId, JSON.stringify(orderPayload)]);
    assert.equal(rowCount, 0, 'duplicate event_id inserts nothing');

    // (b) Even a *new* event id carrying the same order is a no-op (guard is idempotent).
    const id = await enqueue({ eventId: evtId('order-dup-body'), topic: 'orders/create', payload: orderPayload });
    await processWebhookEventById(id);

    const after = await productAllocation(productId);
    assert.deepEqual(after, before, 'no extra allocation');
    const { rows: [c] } = await query('SELECT COUNT(*)::int AS n FROM orders WHERE shopify_order_id = $1', [orderShopifyId]);
    assert.equal(c.n, 1);
  });

  await t.test('webhook + polling for the same order stay idempotent', async () => {
    const before = await productAllocation(productId);
    // Simulate the scheduled sync seeing the same order afterward.
    const result = await applyShopifyOrder(orderPayload);
    assert.equal(result.allocationStatus, 'ALLOCATED');
    assert.equal(result.allocation.alreadyProcessed, true);
    const after = await productAllocation(productId);
    assert.deepEqual(after, before, 'polling does not re-allocate');
    const { rows: [c] } = await query('SELECT COUNT(*)::int AS n FROM orders WHERE shopify_order_id = $1', [orderShopifyId]);
    assert.equal(c.n, 1);
  });

  await t.test('orders/updated refreshes local state without re-allocating', async () => {
    const before = await productAllocation(productId);
    const id = await enqueue({
      eventId: evtId('order-updated'),
      topic: 'orders/updated',
      payload: { ...orderPayload, financial_status: 'refunded', total_price: '5.00', updated_at: '2026-09-02T00:00:00Z' },
    });
    await processWebhookEventById(id);

    const { rows: [order] } = await query('SELECT * FROM orders WHERE shopify_order_id = $1', [orderShopifyId]);
    assert.equal(order.status, 'refunded');
    assert.equal(Number(order.total), 5);
    assert.equal(order.allocation_status, 'ALLOCATED', 'update must not change allocation');
    assert.deepEqual(await productAllocation(productId), before);
  });

  await t.test('an out-of-order (older) order update is ignored', async () => {
    const id = await enqueue({
      eventId: evtId('order-stale'),
      topic: 'orders/updated',
      payload: { ...orderPayload, financial_status: 'paid', total_price: '999.00', updated_at: '2026-08-01T00:00:00Z' },
    });
    await processWebhookEventById(id);
    const { rows: [order] } = await query('SELECT * FROM orders WHERE shopify_order_id = $1', [orderShopifyId]);
    assert.equal(order.status, 'refunded', 'older payload never overwrites newer state');
    assert.equal(Number(order.total), 5);
  });

  await t.test('orders/cancelled releases the reserved stock', async () => {
    const id = await enqueue({ eventId: evtId('order-cancelled'), topic: 'orders/cancelled', payload: { id: orderShopifyId } });
    await processWebhookEventById(id);

    const { rows: [order] } = await query('SELECT allocation_status FROM orders WHERE shopify_order_id = $1', [orderShopifyId]);
    assert.equal(order.allocation_status, 'RELEASED');
    assert.equal((await productAllocation(productId)).allocated, 0, 'reserved stock returned');
  });

  await t.test('an order beyond warehouse stock is rejected at intake', async () => {
    const p = await seedProduct({ shopifyId: pid(), inventory: 1, warehouse: 1, sku: 'SKU-WH-ORD-B' });
    const oId = oid();
    const id = await enqueue({
      eventId: evtId('order-reject'),
      topic: 'orders/create',
      payload: {
        id: oId, financial_status: 'paid', total_price: '50.00', email: 'reject@test.dev',
        created_at: '2026-09-03T00:00:00Z', updated_at: '2026-09-03T00:00:00Z',
        line_items: [{ product_id: p.shopifyId, sku: 'SKU-WH-ORD-B', quantity: 5 }],
      },
    });
    await processWebhookEventById(id);
    const { rows: [order] } = await query('SELECT allocation_status FROM orders WHERE shopify_order_id = $1', [oId]);
    assert.equal(order.allocation_status, 'REJECTED');
    assert.equal((await productAllocation(p.productId)).allocated, 0);
  });

  // ════════════════════════════════════════════════════════════════
  // SECTION 3: Products
  // ════════════════════════════════════════════════════════════════

  let prodShopifyId;
  let productPayload;

  await t.test('products/create upserts the local product', async () => {
    prodShopifyId = pid();
    productPayload = {
      id: prodShopifyId,
      title: 'WH Webhook Product',
      vendor: 'WebhookVendor',
      status: 'active',
      body_html: '<p>webhook body</p>',
      updated_at: '2026-09-01T00:00:00Z',
      variants: [{ price: '9.99', inventory_quantity: 4, inventory_item_id: INV_ITEM_BASE + 1 }],
    };
    const id = await enqueue({ eventId: evtId('product-create'), topic: 'products/create', payload: productPayload });
    await processWebhookEventById(id);

    const { rows: [p] } = await query('SELECT * FROM products WHERE shopify_product_id = $1', [prodShopifyId]);
    assert.ok(p, 'product persisted');
    assert.equal(p.title, 'WH Webhook Product');
    assert.equal(Number(p.inventory), 4);
    assert.equal(Number(p.shopify_inventory_item_id), INV_ITEM_BASE + 1);
  });

  await t.test('duplicate product delivery and polling both keep a single row', async () => {
    const dup = await enqueue({ eventId: evtId('product-dup'), topic: 'products/update', payload: productPayload });
    await processWebhookEventById(dup);
    await upsertProductsFromShopify([productPayload]); // simulate polling

    const { rows: [c] } = await query('SELECT COUNT(*)::int AS n FROM products WHERE shopify_product_id = $1', [prodShopifyId]);
    assert.equal(c.n, 1);
  });

  await t.test('an out-of-order (stale) product update is ignored', async () => {
    const stale = await enqueue({
      eventId: evtId('product-stale'),
      topic: 'products/update',
      payload: { ...productPayload, updated_at: '2026-01-01T00:00:00Z', variants: [{ price: '1.00', inventory_quantity: 999, inventory_item_id: INV_ITEM_BASE + 1 }] },
    });
    await processWebhookEventById(stale);
    const { rows: [p] } = await query('SELECT inventory, price FROM products WHERE shopify_product_id = $1', [prodShopifyId]);
    assert.equal(Number(p.inventory), 4, 'stale inventory never overwrites newer data');
    assert.equal(Number(p.price), 9.99);
  });

  await t.test('products/delete removes the local product', async () => {
    const id = await enqueue({ eventId: evtId('product-delete'), topic: 'products/delete', payload: { id: prodShopifyId } });
    await processWebhookEventById(id);
    const { rows } = await query('SELECT id FROM products WHERE shopify_product_id = $1', [prodShopifyId]);
    assert.equal(rows.length, 0, 'product removed consistently with stale cleanup');
  });

  // ════════════════════════════════════════════════════════════════
  // SECTION 4: Inventory
  // ════════════════════════════════════════════════════════════════

  let invProductShopifyId;
  let invProductId;

  await t.test('inventory_levels/update updates stock and raises one low-stock alert', async () => {
    invProductShopifyId = pid();
    const seeded = await seedProduct({
      shopifyId: invProductShopifyId, inventory: 20, warehouse: 20, sku: 'SKU-WH-INV', inventoryItemId: INV_ITEM_BASE + 2,
    });
    invProductId = seeded.productId;

    const id = await enqueue({
      eventId: evtId('inv-low'),
      topic: 'inventory_levels/update',
      payload: { inventory_item_id: INV_ITEM_BASE + 2, location_id: 1, available: 2, updated_at: '2026-09-04T00:00:00Z' },
    });
    const outcome = await processWebhookEventById(id);
    assert.equal(outcome.status, 'PROCESSED');

    const { rows: [p] } = await query('SELECT inventory FROM products WHERE id = $1', [invProductId]);
    assert.equal(Number(p.inventory), 2);

    const { rows: alerts } = await query('SELECT * FROM inventory_alerts WHERE product_id = $1 AND resolved = FALSE', [invProductId]);
    assert.equal(alerts.length, 1, 'exactly one unresolved alert');
    assert.equal(Number(alerts[0].threshold), 5);
  });

  await t.test('duplicate inventory webhooks never duplicate the alert', async () => {
    const id = await enqueue({
      eventId: evtId('inv-low-dup'),
      topic: 'inventory_levels/update',
      payload: { inventory_item_id: INV_ITEM_BASE + 2, location_id: 1, available: 2 },
    });
    await processWebhookEventById(id);
    const { rows } = await query('SELECT id FROM inventory_alerts WHERE product_id = $1 AND resolved = FALSE', [invProductId]);
    assert.equal(rows.length, 1);
  });

  await t.test('recovered stock resolves the alert', async () => {
    const id = await enqueue({
      eventId: evtId('inv-recover'),
      topic: 'inventory_levels/update',
      payload: { inventory_item_id: INV_ITEM_BASE + 2, location_id: 1, available: 50 },
    });
    await processWebhookEventById(id);
    const { rows: [p] } = await query('SELECT inventory FROM products WHERE id = $1', [invProductId]);
    assert.equal(Number(p.inventory), 50);
    const { rows } = await query('SELECT id FROM inventory_alerts WHERE product_id = $1 AND resolved = FALSE', [invProductId]);
    assert.equal(rows.length, 0, 'alert resolved when stock recovers');
  });

  await t.test('an unknown inventory item is a safe no-op', async () => {
    const id = await enqueue({
      eventId: evtId('inv-unknown'),
      topic: 'inventory_levels/update',
      payload: { inventory_item_id: INV_ITEM_BASE + 999, location_id: 1, available: 7 },
    });
    const outcome = await processWebhookEventById(id);
    assert.equal(outcome.status, 'PROCESSED', 'unknown item is not a failure — polling reconciles later');
  });
});
