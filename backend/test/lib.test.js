// Defense-in-depth: never send real emails from tests (see emailService.js
// EMAIL_MOCK_MODE flag). node --test runs each file in its own process.
process.env.EMAIL_MOCK_MODE = '1';

import test from 'node:test';
import assert from 'node:assert/strict';
import { productFromShopify, shopifyBaseUrl, toApiProduct, orderFromShopify, toApiOrder, toApiInventoryAlert, toApiActivityLog } from '../src/lib.js';

test('builds a Shopify Admin API URL from a shop name', () => {
  assert.equal(shopifyBaseUrl('demo-store'), 'https://demo-store.myshopify.com/admin/api/2024-04');
});

test('maps all Shopify variant inventory into one product', () => {
  const product = productFromShopify({ id: '1', title: 'Mug', image: { src: 'https://cdn.example/mug.jpg' }, variants: [{ price: '9.99', inventory_quantity: 2 }, { price: '12.99', inventory_quantity: 3 }] });
  assert.equal(product.inventory, 5);
  assert.equal(product.price, 9.99);
  assert.equal(product.imageUrl, 'https://cdn.example/mug.jpg');
});

test('falls back to images[0].src when product.image is missing', () => {
  const product = productFromShopify({ id: '1', title: 'Mug', images: [{ src: 'https://cdn.example/gallery.jpg' }] });
  assert.equal(product.imageUrl, 'https://cdn.example/gallery.jpg');
  const noImage = productFromShopify({ id: '2', title: 'No Pic' });
  assert.equal(noImage.imageUrl, null);
});

test('serializes database rows into the public API shape', () => {
  const product = toApiProduct({ id: '1', shopify_product_id: '2', title: 'Mug', inventory: '4', price: '9.99', image_url: 'https://cdn.example/mug.jpg', created_at: '2026-01-01', updated_at: '2026-01-02' });
  assert.deepEqual(product, { id: 1, shopifyProductId: 2, title: 'Mug', description: undefined, vendor: undefined, status: undefined, inventory: 4, price: 9.99, imageUrl: 'https://cdn.example/mug.jpg', createdAt: '2026-01-01', updatedAt: '2026-01-02' });
});

test('maps a Shopify order to database format', () => {
  const shopifyOrder = { id: '42', customer: { first_name: 'John', last_name: 'Doe' }, email: 'john@example.com', financial_status: 'paid', total_price: '129.99', created_at: '2026-07-27T00:00:00Z' };
  const order = orderFromShopify(shopifyOrder);
  assert.equal(order.shopifyOrderId, 42);
  assert.equal(order.customerName, 'John Doe');
  assert.equal(order.email, 'john@example.com');
  assert.equal(order.total, 129.99);
});

test('maps order without customer gracefully', () => {
  const order = orderFromShopify({ id: '1', total_price: '0' });
  assert.equal(order.customerName, null);
  assert.equal(order.email, null);
});

test('serializes order DB row to API shape', () => {
  const api = toApiOrder({ id: '1', shopify_order_id: '42', customer_name: 'John Doe', email: 'j@j.com', status: 'paid', total: '129.99', created_at: '2026-07-27' });
  assert.deepEqual(api, {
    id: 1,
    shopifyOrderId: 42,
    channelCode: 'SHOPIFY',
    orderReference: null,
    allocationStatus: 'UNCHECKED',
    allocationNotes: null,
    itemCount: null,
    customerName: 'John Doe',
    email: 'j@j.com',
    status: 'paid',
    total: 129.99,
    notificationStatus: 'UNNOTIFIED',
    createdAt: '2026-07-27',
  });
});

test('serializes inventory alert DB row to API shape', () => {
  const api = toApiInventoryAlert({ id: '1', product_id: '5', product_title: 'Test Product', shopify_product_id: '99', current_stock: '3', threshold: '10', resolved: false, created_at: '2026-07-27' });
  assert.deepEqual(api, { id: 1, productId: 5, productTitle: 'Test Product', shopifyProductId: 99, currentStock: 3, threshold: 10, resolved: false, createdAt: '2026-07-27' });
});

test('serializes activity log DB row to API shape', () => {
  const api = toApiActivityLog({ id: '1', type: 'SYNC', message: 'done', status: 'SUCCESS', created_at: '2026-07-27' });
  assert.deepEqual(api, { id: 1, type: 'SYNC', message: 'done', status: 'SUCCESS', createdAt: '2026-07-27' });
});
