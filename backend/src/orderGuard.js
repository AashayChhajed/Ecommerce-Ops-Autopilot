/**
 * Over-Order Guard — the core "never oversell" engine.
 *
 * Every order that enters the system — from any sales channel (Shopify,
 * Amazon, Myntra, Flipkart) — is checked against real WAREHOUSE stock before
 * it is accepted:
 *
 *    available = floor(warehouse_quantity × safety_buffer%) − allocated_quantity
 *
 * The safety buffer (default 100%) is configurable so a seller can hold back
 * a reserve for returns, damage and in-transit units.
 *
 * If every line item can be fulfilled from the warehouse, the order is
 * ACCEPTED and its stock is reserved (allocated_quantity incremented).
 * If any line item cannot be fulfilled, the order is REJECTED at intake —
 * so we never accept an order we would later have to cancel.
 *
 * Reservations are released when an order is cancelled (RELEASED) and
 * turned into real warehouse deductions when it ships (FULFILLED).
 *
 * All allocation decisions happen inside a DB transaction with row locks
 * (SELECT … FOR UPDATE), so concurrent orders can never race past the
 * warehouse ceiling. Accepted / released / fulfilled orders also trigger an
 * inventory-feed push that caps every channel listing to current availability
 * (the real-world marketplace feed behavior).
 */

import { query, withTransaction } from './database.js';
import { getChannelIds, logActivity, getSafetyBufferPercent, computeAvailableStock } from './lib.js';
import { updateMockQuantityByProductId } from './channels/index.js';

// The safety buffer (sellable % of warehouse stock) is owned by lib.js so the
// unified inventory view can display the same buffered "available" the guard
// enforces. Re-export here so existing callers (server.js, tests) keep working.
export { getSafetyBufferPercent, computeAvailableStock };

/**
 * Update the global safety buffer (sellable % of warehouse stock).
 * @param {number} bufferPercent - 1..100
 */
export async function updateSafetyBufferPercent(bufferPercent) {
  const pct = Math.min(100, Math.max(1, Math.round(Number(bufferPercent) || 100)));
  const { rows } = await query(`
    INSERT INTO safety_settings (id, buffer_percent, updated_at)
    VALUES (1, $1, NOW())
    ON CONFLICT (id) DO UPDATE SET buffer_percent = EXCLUDED.buffer_percent, updated_at = NOW()
    RETURNING buffer_percent, updated_at
  `, [pct]);
  await logActivity(
    'SAFETY_BUFFER_UPDATED',
    `Safety buffer set to ${pct}% of warehouse stock (sellable = floor(warehouse × ${pct}%) − reserved).`,
    'INFO'
  );
  return { bufferPercent: Number(rows[0].buffer_percent), updatedAt: rows[0].updated_at };
}

/**
 * How much of a product is currently sellable (not already reserved).
 * @param {number} productId
 * @returns {Promise<number|null>} available quantity, or null if unknown
 */
export async function getAvailableStock(productId) {
  const { rows } = await query(
    'SELECT warehouse_quantity, allocated_quantity FROM products WHERE id = $1',
    [productId]
  );
  if (!rows.length) return null;
  const bufferPercent = await getSafetyBufferPercent();
  return computeAvailableStock(rows[0].warehouse_quantity, rows[0].allocated_quantity, bufferPercent);
}

/**
 * Non-mutating availability check for a basket of items.
 * @param {Array<{productId:number, quantity:number}>} items
 * @returns {Promise<{ok:boolean, shortfalls:Array}>}
 */
export async function checkOrderFulfillable(items) {
  const productIds = [...new Set(items.map((i) => i.productId))];
  if (!productIds.length) return { ok: false, shortfalls: [{ reason: 'NO_ITEMS' }] };
  const bufferPercent = await getSafetyBufferPercent();
  const { rows } = await query(
    `SELECT id, title, sku, warehouse_quantity, allocated_quantity
     FROM products WHERE id = ANY($1::bigint[])`,
    [productIds]
  );
  // NB: pg returns BIGINT ids as strings — normalize keys to numbers so
  // lookups by numeric productId always match.
  const map = new Map(rows.map((p) => [Number(p.id), p]));
  const shortfalls = [];
  for (const item of items) {
    const p = map.get(Number(item.productId));
    if (!p) {
      shortfalls.push({ productId: Number(item.productId), requested: item.quantity, available: 0, reason: 'PRODUCT_NOT_FOUND' });
      continue;
    }
    const available = computeAvailableStock(p.warehouse_quantity, p.allocated_quantity, bufferPercent);
    if (available < item.quantity) {
      shortfalls.push({ productId: Number(p.id), title: p.title, sku: p.sku, requested: item.quantity, available });
    }
  }
  return { ok: shortfalls.length === 0, shortfalls };
}

/**
 * Atomic intake guard for an existing order row.
 *
 * Locks the product rows, verifies every line item against warehouse stock,
 * then either:
 *   - ALLOCATED  → reserved stock (allocated_quantity += qty), items recorded
 *   - REJECTED   → order marked REJECTED with shortfall notes, nothing reserved
 *
 * @param {number} orderId
 * @param {Array<{productId:number, quantity:number, channelSku?:string|null}>} items
 * @returns {Promise<{status:'ALLOCATED'|'REJECTED', shortfalls:Array}>}
 */
export async function allocateOrderItems(orderId, items) {
  return withTransaction(async (client) => {
    // Idempotency guard: if this order was already processed, never re-allocate.
    // This prevents double-reservation when the same orderReference is ingested
    // concurrently (e.g. retries, duplicate webhooks).
    const { rows: [orderRow] } = await client.query(
      `SELECT allocation_status FROM orders WHERE id = $1 FOR UPDATE`,
      [orderId]
    );
    if (!orderRow) throw new Error(`Order ${orderId} not found`);
    if (orderRow.allocation_status === 'ALLOCATED' || orderRow.allocation_status === 'REJECTED') {
      return { status: orderRow.allocation_status, shortfalls: [], alreadyProcessed: true };
    }

    const bufferPercent = await getSafetyBufferPercent((text, values) => client.query(text, values));

    const productIds = [...new Set(items.map((i) => i.productId))];
    const { rows: products } = await client.query(
      `SELECT id, title, sku, warehouse_quantity, allocated_quantity
       FROM products WHERE id = ANY($1::bigint[]) ORDER BY id FOR UPDATE`,
      [productIds]
    );
    // NB: pg returns BIGINT ids as strings — normalize keys to numbers so
    // lookups by numeric productId always match.
    const map = new Map(products.map((p) => [Number(p.id), p]));

    // Idempotent re-intake: clear any previous attempt for this order
    await client.query('DELETE FROM order_items WHERE order_id = $1', [orderId]);

    const shortfalls = [];
    for (const item of items) {
      const p = map.get(Number(item.productId));
      if (!p) {
        shortfalls.push({ productId: Number(item.productId), requested: item.quantity, available: 0, reason: 'PRODUCT_NOT_FOUND' });
        continue;
      }
      const available = computeAvailableStock(p.warehouse_quantity, p.allocated_quantity, bufferPercent);
      if (available < item.quantity) {
        shortfalls.push({ productId: Number(p.id), title: p.title, sku: p.sku, requested: item.quantity, available });
      }
    }

    // Always record the attempted line items (so the order is visible with its basket)
    for (const item of items) {
      await client.query(
        `INSERT INTO order_items (order_id, product_id, channel_sku, quantity) VALUES ($1, $2, $3, $4)`,
        [orderId, item.productId, item.channelSku ?? null, item.quantity]
      );
    }

    if (shortfalls.length > 0) {
      await client.query(
        `UPDATE orders SET allocation_status = 'REJECTED', allocation_notes = $2 WHERE id = $1`,
        [orderId, JSON.stringify({ shortfalls, reason: 'insufficient warehouse stock' })]
      );
      return { status: 'REJECTED', shortfalls };
    }

    // Reserve warehouse stock for this order
    for (const item of items) {
      await client.query(
        `UPDATE products SET allocated_quantity = allocated_quantity + $1 WHERE id = $2`,
        [item.quantity, item.productId]
      );
    }
    await client.query(
      `UPDATE orders SET allocation_status = 'ALLOCATED', allocation_notes = NULL WHERE id = $1`,
      [orderId]
    );
    return { status: 'ALLOCATED', shortfalls: [] };
  });
}

/**
 * Ingest a new order from any channel and run it through the guard.
 *
 * @param {object} params
 * @param {string} params.channelCode   - e.g. 'SHOPIFY' | 'AMAZON_MOCK' | ...
 * @param {string} [params.orderReference] - channel-side order id
 * @param {string} [params.customerName]
 * @param {string} [params.email]
 * @param {string} [params.status]      - financial status (default 'paid')
 * @param {number} [params.total]
 * @param {Array<{productId?:number, channelSku?:string, quantity:number}>} params.items
 * @returns {Promise<{orderId:number, status:string, shortfalls:Array, created:boolean}>}
 */
export async function placeChannelOrder({
  channelCode,
  orderReference,
  customerName,
  email,
  status = 'paid',
  total = 0,
  items,
}) {
  const chIds = await getChannelIds();
  const channelId = chIds[channelCode];
  if (!channelId) throw new Error(`Unknown channel: ${channelCode}`);

  // Resolve each line item to an internal product (by productId or channel SKU)
  const resolved = [];
  const unresolved = [];
  for (const item of items) {
    let productId = Number(item.productId);
    let channelSku = item.channelSku ?? null;
    if (!productId && channelSku) {
      const { rows } = await query(
        `SELECT product_id FROM channel_products WHERE channel_id = $1 AND channel_sku = $2 LIMIT 1`,
        [channelId, channelSku]
      );
      productId = rows[0]?.product_id ? Number(rows[0].product_id) : null;
    }
    if (!productId) {
      unresolved.push({ channelSku, requested: Math.max(1, Number(item.quantity) || 1), reason: 'PRODUCT_NOT_FOUND' });
      continue;
    }
    resolved.push({ productId, quantity: Math.max(1, Math.floor(Number(item.quantity) || 1)), channelSku });
  }

  if (resolved.length === 0) {
    throw new Error(`No line items could be matched to products on channel ${channelCode}`);
  }

  // Insert the order row. Shopify orders keep shopify_order_id; mock channels
  // use (channel_code, order_reference) as their unique key.
  const shopifyOrderId =
    channelCode === 'SHOPIFY' && /^\d+$/.test(String(orderReference ?? '')) ? Number(orderReference) : null;

  const insertSql = shopifyOrderId !== null
    ? `INSERT INTO orders (shopify_order_id, channel_code, customer_name, email, status, total, allocation_status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'UNCHECKED', NOW())
       ON CONFLICT (shopify_order_id) DO UPDATE SET
         customer_name = EXCLUDED.customer_name, email = EXCLUDED.email,
         status = EXCLUDED.status, total = EXCLUDED.total
       RETURNING id, allocation_status, created_at`
    : `INSERT INTO orders (channel_code, order_reference, customer_name, email, status, total, allocation_status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'UNCHECKED', NOW())
       ON CONFLICT (channel_code, order_reference) WHERE order_reference IS NOT NULL DO UPDATE SET
         customer_name = EXCLUDED.customer_name, email = EXCLUDED.email,
         status = EXCLUDED.status, total = EXCLUDED.total
       RETURNING id, allocation_status, created_at`;

  const insertParams = shopifyOrderId !== null
    ? [shopifyOrderId, channelCode, customerName ?? null, email ?? null, status, total]
    : [channelCode, orderReference ?? null, customerName ?? null, email ?? null, status, total];

  const { rows: [order] } = await query(insertSql, insertParams);

  // If this orderReference was already processed on a previous intake (e.g. a
  // duplicate webhook or a retry), do NOT re-run the guard — a re-sent payload
  // must never reverse an accepted order's status or double-reserve stock.
  if (order.allocation_status === 'ALLOCATED' || order.allocation_status === 'REJECTED') {
    return {
      orderId: Number(order.id),
      channelCode,
      status: order.allocation_status,
      shortfalls: [],
      createdAt: order.created_at,
      alreadyProcessed: true,
    };
  }

  // Never accept an order we cannot fully map to products: if ANY line item is
  // unresolvable, reject the whole order instead of silently under-fulfilling it.
  if (unresolved.length > 0) {
    await query(
      `UPDATE orders SET allocation_status = 'REJECTED', allocation_notes = $2 WHERE id = $1`,
      [order.id, JSON.stringify({ unresolved, reason: 'one or more line items could not be matched to a product' })]
    );
    return {
      orderId: Number(order.id),
      channelCode,
      status: 'REJECTED',
      shortfalls: unresolved,
      createdAt: order.created_at,
    };
  }

  const result = await allocateOrderItems(order.id, resolved);

  // If accepted, push the inventory feed: reflect the sale on EVERY channel's
  // listing for the affected products (caps listings to the new available),
  // mirroring the real-world marketplace inventory feed. Never re-push for a
  // duplicate intake of the same order.
  if (result.status === 'ALLOCATED' && !result.alreadyProcessed) {
    await pushInventoryFeed(resolved.map((i) => i.productId));
  }

  return {
    orderId: Number(order.id),
    channelCode,
    status: result.status,
    shortfalls: result.shortfalls,
    createdAt: order.created_at,
  };
}

/**
 * Cancel an order and give its reserved stock back to the sellable pool.
 * @param {number} orderId
 * @returns {Promise<{status:string, changed:boolean, releasedItems?:number}>}
 */
export async function releaseOrderAllocation(orderId) {
  // Phase 2 fix: the inventory-feed push used to live AFTER `return withTransaction(...)`
  // — unreachable dead code. It now runs after the transaction commits.
  const result = await withTransaction(async (client) => {
    const { rows: [order] } = await client.query(
      'SELECT allocation_status, channel_code FROM orders WHERE id = $1',
      [orderId]
    );
    if (!order) return { status: 'NOT_FOUND', changed: false };
    if (order.allocation_status !== 'ALLOCATED') {
      return { status: order.allocation_status, changed: false };
    }
    const { rows: items } = await client.query(
      'SELECT product_id, quantity FROM order_items WHERE order_id = $1',
      [orderId]
    );
    for (const it of items) {
      await client.query(
        `UPDATE products SET allocated_quantity = GREATEST(0, allocated_quantity - $1) WHERE id = $2`,
        [it.quantity, it.product_id]
      );
    }
    // Restore the source channel's listing so cancelled units can be sold again
    // (mirrors the decrement that happens on accept for marketplace channels).
    if (order.channel_code && order.channel_code !== 'SHOPIFY') {
      const { rows: [channel] } = await client.query(
        `SELECT id FROM channels WHERE code = $1`,
        [order.channel_code]
      );
      if (channel) {
        for (const it of items) {
          const { rows } = await client.query(
            `UPDATE channel_products SET available_quantity = available_quantity + $1, updated_at = NOW()
             WHERE channel_id = $2 AND product_id = $3 RETURNING available_quantity`,
            [it.quantity, channel.id, it.product_id]
          );
          if (rows.length) {
            const mockResult = updateMockQuantityByProductId(order.channel_code, Number(it.product_id), Number(rows[0].available_quantity));
            if (!mockResult.success) {
              console.warn(`[OrderGuard] Mock store has no listing for product #${it.product_id} on ${order.channel_code}; DB updated, in-memory drift will be corrected by reconcile.`);
            }
          }
        }
      }
    }
    await client.query(
      `UPDATE orders SET allocation_status = 'RELEASED', allocation_notes = 'Stock released (order cancelled).' WHERE id = $1`,
      [orderId]
    );
    return { status: 'RELEASED', changed: true, releasedItems: items.length, productIds: items.map((it) => Number(it.product_id)) };
  });

  // Inventory feed: after the commit, re-push corrected availability to every
  // channel listing so released units are never over-advertised anywhere.
  if (result.changed && result.productIds?.length) {
    await pushInventoryFeed(result.productIds);
  }
  return { status: result.status, changed: result.changed, releasedItems: result.releasedItems };
}

/**
 * Ship an order: deduct its reserved units from the warehouse and clear the reservation.
 * @param {number} orderId
 * @returns {Promise<{status:string, changed:boolean, fulfilledItems?:number}>}
 */
export async function fulfillOrderAllocation(orderId) {
  // Phase 2 fix: same unreachable feed-push problem as releaseOrderAllocation.
  const result = await withTransaction(async (client) => {
    const { rows: [order] } = await client.query(
      'SELECT allocation_status FROM orders WHERE id = $1',
      [orderId]
    );
    if (!order) return { status: 'NOT_FOUND', changed: false };
    if (order.allocation_status !== 'ALLOCATED') {
      return { status: order.allocation_status, changed: false };
    }
    const { rows: items } = await client.query(
      'SELECT product_id, quantity FROM order_items WHERE order_id = $1',
      [orderId]
    );
    for (const it of items) {
      await client.query(
        `UPDATE products SET
           warehouse_quantity = GREATEST(0, warehouse_quantity - $1),
           allocated_quantity = GREATEST(0, allocated_quantity - $1)
         WHERE id = $2`,
        [it.quantity, it.product_id]
      );
    }
    await client.query(
      `UPDATE orders SET allocation_status = 'FULFILLED', allocation_notes = 'Fulfilled from warehouse.' WHERE id = $1`,
      [orderId]
    );
    return { status: 'FULFILLED', changed: true, fulfilledItems: items.length, productIds: items.map((it) => Number(it.product_id)) };
  });

  // Inventory feed: after shipment, push the reduced availability to every
  // channel listing so no marketplace still shows units that were shipped.
  if (result.changed && result.productIds?.length) {
    await pushInventoryFeed(result.productIds);
  }
  return { status: result.status, changed: result.changed, fulfilledItems: result.fulfilledItems };
}

/**
 * Simulate the marketplace inventory feed: after any stock-affecting event,
 * push each product's current sellable quantity to its channel listings,
 * capping any listing that advertises more than the warehouse can actually
 * ship (under the safety buffer). Listings are only ever capped — never
 * raised — matching the reconcile policy, so they converge toward reality
 * without ever over-advertising. Corrected quantities are mirrored into the
 * in-memory mock stores too.
 *
 * @param {Array<number|string>} productIds
 * @returns {Promise<{adjusted:number, details:Array}>}
 */
export async function pushInventoryFeed(productIds) {
  const bufferPercent = await getSafetyBufferPercent();
  let adjusted = 0;
  const details = [];

  for (const rawPid of productIds) {
    const productId = Number(rawPid);
    if (!productId) continue;

    const { rows: [p] } = await query(
      'SELECT id, warehouse_quantity, allocated_quantity FROM products WHERE id = $1',
      [productId]
    );
    if (!p) continue;

    const available = computeAvailableStock(p.warehouse_quantity, p.allocated_quantity, bufferPercent);

    const { rows: listings } = await query(
      `SELECT cp.id, cp.channel_sku, cp.available_quantity, c.code AS channel_code
       FROM channel_products cp JOIN channels c ON c.id = cp.channel_id
       WHERE cp.product_id = $1`,
      [productId]
    );

    for (const l of listings) {
      if (Number(l.available_quantity) > available) {
        await query(
          `UPDATE channel_products SET available_quantity = $1, updated_at = NOW() WHERE id = $2`,
          [available, l.id]
        );
        const mockResult = updateMockQuantityByProductId(l.channel_code, productId, available);
        if (!mockResult.success) {
          console.warn(`[OrderGuard] Mock store has no listing for product #${productId} on ${l.channel_code}; DB updated, in-memory drift corrected on next sync.`);
        }
        adjusted += 1;
        details.push({ productId, channel: l.channel_code, channelSku: l.channel_sku, old: Number(l.available_quantity), new: available });
      }
    }
  }

  return { adjusted, details };
}

/**
 * Reconcile channel listings so no channel ever advertises more than the
 * warehouse can actually fulfill (buffered available). Channel quantities
 * are capped — never raised — so listings converge toward reality.
 *
 * @returns {Promise<{adjusted:number, details:Array}>}
 */
export async function reconcileChannelListings() {
  const bufferPercent = await getSafetyBufferPercent();
  const { rows: products } = await query(
    `SELECT id, warehouse_quantity, allocated_quantity FROM products ORDER BY id`
  );

  let adjusted = 0;
  const details = [];

  for (const p of products) {
    const available = computeAvailableStock(p.warehouse_quantity, p.allocated_quantity, bufferPercent);

    const { rows: listings } = await query(
      `SELECT cp.id, cp.channel_id, cp.channel_sku, cp.available_quantity, c.code AS channel_code
       FROM channel_products cp JOIN channels c ON c.id = cp.channel_id
       WHERE cp.product_id = $1 ORDER BY cp.available_quantity DESC`,
      [p.id]
    );

    let remaining = available;
    for (const l of listings) {
      const capped = Math.min(Number(l.available_quantity), remaining);
      remaining = Math.max(0, remaining - capped);
      if (capped !== Number(l.available_quantity)) {
        await query(
          `UPDATE channel_products SET available_quantity = $1, updated_at = NOW() WHERE id = $2`,
          [capped, l.id]
        );
        const mockResult = updateMockQuantityByProductId(l.channel_code, Number(p.id), capped);
        if (!mockResult.success) {
          console.warn(`[OrderGuard] Mock store has no listing for product #${p.id} on ${l.channel_code}; DB updated, in-memory drift will be corrected on next mock sync.`);
        }
        adjusted += 1;
        details.push({
          productId: Number(p.id),
          channel: l.channel_code,
          channelSku: l.channel_sku,
          old: Number(l.available_quantity),
          new: capped,
        });
      }
    }
  }

  return { adjusted, details };
}

/**
 * Fetch a single order's line items (resolved with product titles/SKUs).
 * @param {number} orderId
 */
export async function getOrderItems(orderId) {
  const { rows } = await query(
    `SELECT oi.id, oi.product_id, oi.channel_sku, oi.quantity,
            p.title AS product_title, p.sku AS product_sku
     FROM order_items oi JOIN products p ON p.id = oi.product_id
     WHERE oi.order_id = $1 ORDER BY oi.id`,
    [orderId]
  );
  return rows;
}
