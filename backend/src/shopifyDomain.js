/**
 * Shared Shopify domain operations (Phase 3).
 *
 * The scheduled sync (server.js) and the webhook processor (webhooks.js) both
 * drive these functions, so a record arriving through EITHER path results in
 * exactly the same database changes. Nothing here talks HTTP or knows about
 * webhooks — it is the normalized Shopify → local-domain layer.
 *
 * Idempotency is enforced at the database level:
 *   - products upsert on the UNIQUE shopify_product_id
 *   - orders upsert on the UNIQUE shopify_order_id
 *   - allocation only runs while an order is still UNCHECKED (orderGuard is
 *     authoritative and returns early for ALLOCATED/REJECTED rows)
 *   - stale product/order payloads are ignored via Shopify's updated_at
 */

import { query } from './database.js';
import {
  productFromShopify,
  orderFromShopify,
  maybeCreateLowStockAlert,
  resolveProductInventoryAlert,
} from './lib.js';
import { allocateOrderItems, releaseOrderAllocation, pushInventoryFeed } from './orderGuard.js';

/**
 * A webhook failure that must NOT be retried (invalid payload, impossible
 * business data, unsupported topic...). Anything else is treated as transient.
 */
export class WebhookPermanentError extends Error {
  constructor(message, { cause } = {}) {
    super(message);
    this.name = 'WebhookPermanentError';
    this.permanent = true;
    if (cause) this.cause = cause;
  }
}

// ──────────────────────────────────────────────
// Products
// ──────────────────────────────────────────────

/**
 * Upsert Shopify products into the local products table.
 * Accepts RAW Shopify product payloads (normalization happens here so the
 * polling sync and webhooks share one code path).
 *
 * warehouse_quantity is only initialized from Shopify stock when it is still 0
 * (existing behavior — the warehouse is the real stock and is never clobbered
 * by a channel sync). A payload whose shopify_updated_at is older than what we
 * already stored is ignored so out-of-order deliveries converge.
 *
 * @param {Array<object>} rawProducts
 * @returns {Promise<{upserted:number, shopifyIds:number[]}>}
 */
export async function upsertProductsFromShopify(rawProducts) {
  const products = (rawProducts ?? [])
    .map(productFromShopify)
    .filter((p) => Number.isFinite(p.shopifyProductId));

  if (!products.length) return { upserted: 0, shopifyIds: [] };

  const values = products.map((_, i) => {
    const b = i * 11 + 1;
    return `($${b},$${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9},$${b + 10},NOW(),NOW())`;
  });
  const flat = products.flatMap((p) => [
    p.shopifyProductId, p.title, p.description, p.vendor, p.status,
    p.inventory, p.inventory, p.price, p.imageUrl,
    p.inventoryItemId ?? null, p.shopifyUpdatedAt ?? null,
  ]);

  await query(`
    INSERT INTO products (
      shopify_product_id, title, description, vendor, status,
      inventory, warehouse_quantity, price, image_url,
      shopify_inventory_item_id, shopify_updated_at, created_at, updated_at
    )
    VALUES ${values.join(',')}
    ON CONFLICT (shopify_product_id) DO UPDATE SET
      title = EXCLUDED.title,
      description = EXCLUDED.description,
      vendor = EXCLUDED.vendor,
      status = EXCLUDED.status,
      inventory = EXCLUDED.inventory,
      warehouse_quantity = CASE
        WHEN products.warehouse_quantity = 0 THEN EXCLUDED.inventory
        ELSE products.warehouse_quantity
      END,
      price = EXCLUDED.price,
      image_url = EXCLUDED.image_url,
      shopify_inventory_item_id = COALESCE(EXCLUDED.shopify_inventory_item_id, products.shopify_inventory_item_id),
      shopify_updated_at = EXCLUDED.shopify_updated_at,
      updated_at = NOW()
    WHERE products.shopify_updated_at IS NULL
       OR EXCLUDED.shopify_updated_at IS NULL
       OR EXCLUDED.shopify_updated_at >= products.shopify_updated_at
  `, flat);

  return { upserted: products.length, shopifyIds: products.map((p) => p.shopifyProductId) };
}

/**
 * Delete local products whose Shopify id is no longer present.
 * Used by the polling sync's stale-product cleanup.
 * @param {number[]} shopifyIds
 */
export async function removeStaleShopifyProducts(shopifyIds) {
  if (!shopifyIds?.length) return { deleted: 0 };
  const { rowCount } = await query(
    `DELETE FROM products WHERE shopify_product_id != ALL($1::bigint[])`,
    [shopifyIds]
  );
  return { deleted: rowCount };
}

/**
 * Delete a single local product by its Shopify id (products/delete webhook).
 * ON DELETE CASCADE removes dependent alerts, descriptions, listings and line
 * items — identical to the polling stale-cleanup semantics.
 * @param {number} shopifyProductId
 */
export async function deleteProductByShopifyId(shopifyProductId) {
  const { rowCount } = await query(
    `DELETE FROM products WHERE shopify_product_id = $1`,
    [shopifyProductId]
  );
  return { deleted: rowCount };
}

// ──────────────────────────────────────────────
// Orders
// ──────────────────────────────────────────────

/**
 * Resolve Shopify line items to internal product ids (by Shopify product id,
 * then by SKU). Shared by the polling sync and the webhook processor.
 * @param {Array<object>} lineItems
 * @returns {Promise<{resolved:Array, unresolved:Array}>}
 */
export async function resolveShopifyLineItems(lineItems) {
  const byShopifyId = new Set();
  const bySku = new Set();
  for (const li of lineItems ?? []) {
    if (li?.product_id) byShopifyId.add(Number(li.product_id));
    if (li?.sku) bySku.add(String(li.sku));
  }

  const lookup = {};
  if (byShopifyId.size) {
    const { rows } = await query(
      `SELECT id, shopify_product_id FROM products WHERE shopify_product_id = ANY($1::bigint[])`,
      [[...byShopifyId]]
    );
    for (const r of rows) lookup[Number(r.shopify_product_id)] = Number(r.id);
  }
  if (bySku.size) {
    const { rows } = await query(
      `SELECT id, sku FROM products WHERE sku = ANY($1)`,
      [[...bySku]]
    );
    for (const r of rows) if (!lookup[r.sku]) lookup[r.sku] = Number(r.id);
  }

  const resolved = [];
  const unresolved = [];
  for (const li of lineItems ?? []) {
    const productId = lookup[Number(li?.product_id)] ?? lookup[String(li?.sku)] ?? null;
    const quantity = Math.max(1, Number(li?.quantity) || 1);
    if (productId) {
      resolved.push({ productId, quantity, channelSku: li?.sku ?? null });
    } else {
      unresolved.push({
        channelSku: li?.sku ?? null,
        shopifyProductId: li?.product_id ? Number(li.product_id) : null,
        requested: quantity,
        reason: 'PRODUCT_NOT_FOUND',
      });
    }
  }
  return { resolved, unresolved };
}

/**
 * Insert/update a local order row from a Shopify order payload.
 * Status/total are only overwritten when the incoming shopify_updated_at is
 * not older than the stored one, so an out-of-order orders/updated can never
 * regress newer state.
 *
 * @param {object} rawShopifyOrder
 * @returns {Promise<{orderId:number, allocationStatus:string, isNew:boolean}>}
 */
export async function upsertShopifyOrder(rawShopifyOrder) {
  const o = orderFromShopify(rawShopifyOrder);
  if (!Number.isFinite(o.shopifyOrderId)) {
    throw new WebhookPermanentError('Shopify order payload is missing a numeric id');
  }

  const { rows } = await query(`
    INSERT INTO orders (shopify_order_id, channel_code, customer_name, email, status, total, created_at, shopify_updated_at)
    VALUES ($1, 'SHOPIFY', $2, $3, $4, $5, $6, $7)
    ON CONFLICT (shopify_order_id) DO UPDATE SET
      customer_name = EXCLUDED.customer_name,
      email = EXCLUDED.email,
      status = CASE
        WHEN orders.shopify_updated_at IS NULL
          OR EXCLUDED.shopify_updated_at IS NULL
          OR EXCLUDED.shopify_updated_at >= orders.shopify_updated_at
        THEN EXCLUDED.status ELSE orders.status END,
      total = CASE
        WHEN orders.shopify_updated_at IS NULL
          OR EXCLUDED.shopify_updated_at IS NULL
          OR EXCLUDED.shopify_updated_at >= orders.shopify_updated_at
        THEN EXCLUDED.total ELSE orders.total END,
      shopify_updated_at = GREATEST(orders.shopify_updated_at, EXCLUDED.shopify_updated_at)
    RETURNING id, allocation_status, (xmax = 0) AS is_new
  `, [
    o.shopifyOrderId, o.customerName, o.email, o.status, o.total,
    o.createdAt || new Date().toISOString(), o.updatedAt,
  ]);

  return {
    orderId: Number(rows[0].id),
    allocationStatus: rows[0].allocation_status,
    isNew: rows[0].is_new,
  };
}

/**
 * Apply a Shopify order payload through the SAME over-order guard the polling
 * sync uses. Safe to call repeatedly for the same order: the guard is
 * idempotent and refuses to re-allocate an order that is already
 * ALLOCATED/REJECTED.
 *
 * @param {object} rawShopifyOrder
 * @returns {Promise<{orderId:number, isNew:boolean, allocation:object|null}>}
 */
export async function applyShopifyOrder(rawShopifyOrder) {
  const up = await upsertShopifyOrder(rawShopifyOrder);

  // Already decided (by polling, a previous webhook, or a bulk insert).
  if (up.allocationStatus !== 'UNCHECKED') {
    return { ...up, allocation: { status: up.allocationStatus, shortfalls: [], alreadyProcessed: true } };
  }

  const { resolved, unresolved } = await resolveShopifyLineItems(rawShopifyOrder?.line_items ?? []);

  // No resolvable line items (e.g. the product hasn't been synced yet): leave
  // the order UNCHECKED so the next reconciliation can allocate it. Never mark
  // it rejected on missing data.
  if (resolved.length === 0) {
    return { ...up, allocation: null };
  }

  if (unresolved.length > 0) {
    await query(
      `UPDATE orders SET allocation_status = 'REJECTED', allocation_notes = $2 WHERE id = $1`,
      [up.orderId, JSON.stringify({ unresolved, reason: 'one or more line items could not be matched to a product' })]
    );
    return { ...up, allocation: { status: 'REJECTED', shortfalls: unresolved } };
  }

  const allocation = await allocateOrderItems(up.orderId, resolved);
  if (allocation.status === 'ALLOCATED' && !allocation.alreadyProcessed) {
    await pushInventoryFeed(resolved.map((i) => i.productId));
  }
  return { ...up, allocation };
}

/**
 * Cancel a Shopify order by Shopify id — releases its reserved stock through
 * the existing orderGuard semantics. A missing local order is a safe no-op
 * (the cancelled webhook may arrive before the create webhook/polling).
 * @param {number} shopifyOrderId
 */
export async function cancelShopifyOrderByShopifyId(shopifyOrderId) {
  if (!Number.isFinite(shopifyOrderId)) {
    throw new WebhookPermanentError('orders/cancelled payload is missing a numeric id');
  }
  const { rows } = await query(
    `SELECT id FROM orders WHERE shopify_order_id = $1`,
    [shopifyOrderId]
  );
  if (!rows.length) return { status: 'NOT_FOUND', changed: false };
  return releaseOrderAllocation(rows[0].id);
}

// ──────────────────────────────────────────────
// Inventory
// ──────────────────────────────────────────────

/**
 * Apply an inventory_levels/update webhook.
 *
 * The local inventory model keeps one Shopify quantity per product (the sum of
 * variant quantities) plus a separate warehouse_quantity. This webhook updates
 * the Shopify-synced `inventory` for the product that owns the inventory item,
 * preserving low-stock detection and alert dedup via the shared helpers.
 *
 * If the inventory item is unknown locally the event is a safe no-op (the
 * product may not be synced yet) — polling reconciles it later.
 *
 * @param {object} payload
 * @returns {Promise<{status:'UPDATED'|'IGNORED', productId?:number, available?:number}>}
 */
export async function applyInventoryLevelUpdate(payload) {
  const inventoryItemId = Number(payload?.inventory_item_id);
  const available = Number(payload?.available);
  if (!Number.isFinite(inventoryItemId)) {
    throw new WebhookPermanentError('inventory_levels/update payload is missing inventory_item_id');
  }
  if (!Number.isFinite(available)) {
    throw new WebhookPermanentError('inventory_levels/update payload is missing a numeric available');
  }

  const { rows } = await query(
    `SELECT id, title, sku FROM products WHERE shopify_inventory_item_id = $1 FOR UPDATE`,
    [inventoryItemId]
  );
  if (!rows.length) {
    return { status: 'IGNORED', reason: 'unknown inventory item' };
  }
  const product = rows[0];

  const { rows: [updated] } = await query(`
    UPDATE products SET
      inventory = $1,
      warehouse_quantity = CASE WHEN warehouse_quantity = 0 THEN $1 ELSE warehouse_quantity END,
      updated_at = NOW()
    WHERE id = $2
    RETURNING id, title, sku, inventory
  `, [available, product.id]);

  // Preserve low-stock alerting: create when low (deduped) and resolve when
  // stock recovers. Identical rules to the hourly inventory audit.
  await maybeCreateLowStockAlert(updated);
  await resolveProductInventoryAlert(updated.id, updated.inventory);

  return { status: 'UPDATED', productId: Number(updated.id), available };
}
