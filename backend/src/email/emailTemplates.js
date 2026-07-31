/**
 * Email template builders for transactional notifications.
 *
 * Each template provides both an HTML version (rich email body)
 * and a plain-text fallback. Keep these simple — they are designed
 * for the Mailtrap sandbox and can be extended later for production.
 */

// ──────────────────────────────────────────────
// Order Confirmation
// ──────────────────────────────────────────────

export function buildOrderEmailHtml(order) {
  const total = Number(order.total).toFixed(2);
  return `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:20px;background:#fff;border-radius:8px;">
    <div style="background:#6366f1;color:#fff;padding:20px;border-radius:8px 8px 0 0;text-align:center;">
      <h2 style="margin:0;font-size:20px;">Order Confirmed</h2>
    </div>
    <div style="padding:20px;">
      <p>Hi <strong>${order.customer_name || 'Valued Customer'}</strong>,</p>
      <p>Your order <strong>#${order.shopify_order_id}</strong> has been received and is being processed.</p>
      <table style="width:100%;border-collapse:collapse;margin:16px 0;">
        <tr><td style="padding:10px 0;border-bottom:1px solid #eee;color:#666;">Order ID</td><td style="padding:10px 0;border-bottom:1px solid #eee;text-align:right;font-weight:bold;">#${order.shopify_order_id}</td></tr>
        <tr><td style="padding:10px 0;border-bottom:1px solid #eee;color:#666;">Order Total</td><td style="padding:10px 0;border-bottom:1px solid #eee;text-align:right;font-weight:bold;">$${total}</td></tr>
        <tr><td style="padding:10px 0;border-bottom:1px solid #eee;color:#666;">Status</td><td style="padding:10px 0;border-bottom:1px solid #eee;text-align:right;text-transform:capitalize;">${order.status}</td></tr>
        <tr><td style="padding:10px 0;color:#666;">Customer</td><td style="padding:10px 0;text-align:right;">${order.email || '—'}</td></tr>
      </table>
      <p style="color:#666;font-size:14px;">We'll notify you when your order ships. If you have any questions, feel free to reply to this email.</p>
    </div>
    <div style="padding:16px 20px;border-top:1px solid #eee;text-align:center;color:#999;font-size:12px;">
      WeSee E-Commerce Autopilot &middot; Shopify Operations<br/>
      <span style="color:#ccc;">Sent via Mailtrap Sandbox — not a real customer email</span>
    </div>
  </div>`;
}

export function buildOrderEmailPlainText(order) {
  const total = Number(order.total).toFixed(2);
  return [
    `ORDER CONFIRMATION — #${order.shopify_order_id}`,
    '',
    `Hi ${order.customer_name || 'Valued Customer'},`,
    '',
    `Your order #${order.shopify_order_id} has been received and is being processed.`,
    '',
    `Order ID: #${order.shopify_order_id}`,
    `Total: $${total}`,
    `Status: ${order.status}`,
    `Customer: ${order.email || '—'}`,
    '',
    'We\'ll notify you when your order ships.',
    '',
    '— WeSee E-Commerce Autopilot (Mailtrap Sandbox)',
  ].join('\n');
}

// ──────────────────────────────────────────────
// Low Stock Alert
// ──────────────────────────────────────────────

export function buildLowStockAlertHtml(product, warehouseQty, threshold) {
  return `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:20px;background:#fff;border-radius:8px;">
    <div style="background:#f59e0b;color:#1a1a1a;padding:20px;border-radius:8px 8px 0 0;text-align:center;">
      <h2 style="margin:0;font-size:20px;">⚠ Low Stock Alert</h2>
    </div>
    <div style="padding:20px;">
      <p style="color:#333;">The following product is running low on inventory:</p>
      <table style="width:100%;border-collapse:collapse;margin:16px 0;">
        <tr><td style="padding:10px 0;border-bottom:1px solid #eee;color:#666;">Product</td><td style="padding:10px 0;border-bottom:1px solid #eee;text-align:right;font-weight:bold;">${product.title}</td></tr>
        <tr><td style="padding:10px 0;border-bottom:1px solid #eee;color:#666;">SKU</td><td style="padding:10px 0;border-bottom:1px solid #eee;text-align:right;font-family:monospace;">${product.sku || '—'}</td></tr>
        <tr><td style="padding:10px 0;border-bottom:1px solid #eee;color:#666;">Current Quantity</td><td style="padding:10px 0;border-bottom:1px solid #eee;text-align:right;"><span style="color:#dc2626;font-weight:bold;">${warehouseQty}</span></td></tr>
        <tr><td style="padding:10px 0;color:#666;">Threshold</td><td style="padding:10px 0;text-align:right;font-weight:bold;">${threshold}</td></tr>
      </table>
      <p style="color:#666;font-size:14px;">Please restock this product as soon as possible to avoid stockouts and lost sales.</p>
      ${process.env.ADMIN_PANEL_URL
        ? `<a href="${process.env.ADMIN_PANEL_URL}" style="display:inline-block;background:#6366f1;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:bold;margin:8px 0;">View in Dashboard</a>`
        : ''}
    </div>
    <div style="padding:16px 20px;border-top:1px solid #eee;text-align:center;color:#999;font-size:12px;">
      WeSee E-Commerce Autopilot &middot; Inventory Monitoring<br/>
      <span style="color:#ccc;">Sent via Mailtrap Sandbox — alert for testing purposes</span>
    </div>
  </div>`;
}

export function buildLowStockAlertPlainText(product, warehouseQty, threshold) {
  return [
    '⚠ LOW STOCK ALERT',
    '',
    `Product: ${product.title}`,
    `SKU: ${product.sku || '—'}`,
    `Current Quantity: ${warehouseQty}`,
    `Threshold: ${threshold}`,
    '',
    'Please restock this product as soon as possible to avoid stockouts.',
    '',
    `— WeSee E-Commerce Autopilot (Mailtrap Sandbox)`,
  ].join('\n');
}
