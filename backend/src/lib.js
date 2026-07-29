import { query } from './database.js';
import { buildDescriptionPrompt, generateWithGemini } from './gemini.js';

export function shopifyBaseUrl(shopName, apiVersion = '2024-04') {
  if (!shopName?.trim()) throw new Error('SHOPIFY_SHOP_NAME is not configured');
  const domain = shopName.trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const host = domain.includes('.') ? domain : `${domain.toLowerCase().replace(/\s+/g, '-')}.myshopify.com`;
  return `https://${host}/admin/api/${apiVersion}`;
}

export function productFromShopify(product) {
  const variants = product.variants ?? [];
  const firstVariant = variants[0];
  return {
    shopifyProductId: Number(product.id),
    title: product.title ?? 'Untitled product',
    description: product.body_html ?? null,
    vendor: product.vendor ?? null,
    status: product.status ?? null,
    price: Number(firstVariant?.price ?? 0),
    inventory: variants.reduce((total, v) => total + Number(v.inventory_quantity ?? 0), 0),
  };
}

export function toApiProduct(row) {
  return {
    id: Number(row.id),
    shopifyProductId: Number(row.shopify_product_id),
    title: row.title,
    description: row.description,
    vendor: row.vendor,
    status: row.status,
    inventory: Number(row.inventory),
    price: Number(row.price),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function orderFromShopify(shopifyOrder) {
  return {
    shopifyOrderId: Number(shopifyOrder.id),
    customerName: shopifyOrder.customer
      ? `${shopifyOrder.customer.first_name ?? ''} ${shopifyOrder.customer.last_name ?? ''}`.trim() || null
      : null,
    email: shopifyOrder.email ?? null,
    status: shopifyOrder.financial_status ?? 'pending',
    total: Number(shopifyOrder.total_price ?? 0),
    createdAt: shopifyOrder.created_at,
  };
}

export function toApiOrder(row) {
  return {
    id: Number(row.id),
    shopifyOrderId: Number(row.shopify_order_id),
    customerName: row.customer_name,
    email: row.email,
    status: row.status,
    total: Number(row.total),
    notificationStatus: row.notification_status ?? 'UNNOTIFIED',
    createdAt: row.created_at,
  };
}

export function toApiInventoryAlert(row) {
  return {
    id: Number(row.id),
    productId: Number(row.product_id),
    productTitle: row.product_title ?? null,
    shopifyProductId: row.shopify_product_id ? Number(row.shopify_product_id) : null,
    currentStock: Number(row.current_stock),
    threshold: Number(row.threshold),
    resolved: Boolean(row.resolved),
    createdAt: row.created_at,
  };
}

export function toApiActivityLog(row) {
  return {
    id: Number(row.id),
    type: row.type,
    message: row.message,
    status: row.status,
    createdAt: row.created_at,
  };
}

export function toApiSchedulerRun(row) {
  return {
    id: Number(row.id),
    jobName: row.job_name,
    started: row.started,
    finished: row.finished ?? null,
    status: row.status,
    durationMs: row.duration ?? null,
    errorMessage: row.error_message ?? null,
  };
}

export function toApiDescription(row) {
  return {
    id: Number(row.id),
    productId: Number(row.product_id),
    productTitle: row.product_title ?? null,
    vendor: row.vendor ?? null,
    generatedDescription: row.generated_description,
    approved: Boolean(row.approved),
    generatedAt: row.generated_at,
  };
}

// ──────────────────────────────────────────────
// Service / domain functions (no HTTP side effects)
// ──────────────────────────────────────────────

export async function logActivity(type, message, status = 'INFO') {
  try {
    await query(
      `INSERT INTO activity_logs (type, message, status) VALUES ($1, $2, $3)`,
      [type, message, status]
    );
  } catch (err) {
    console.error('[ActivityLog] Failed to write log:', err.message);
  }
}

export async function auditInventory() {
  const { rows: lowStock } = await query(
    `SELECT id, title, inventory FROM products WHERE inventory <= 5 AND inventory >= 0`
  );
  let alertsCreated = 0;
  for (const product of lowStock) {
    const { rows: existing } = await query(
      'SELECT id FROM inventory_alerts WHERE product_id = $1 AND resolved = FALSE',
      [product.id]
    );
    if (existing.length === 0) {
      await query(
        'INSERT INTO inventory_alerts (product_id, current_stock, threshold) VALUES ($1, $2, 5)',
        [product.id, product.inventory]
      );
      alertsCreated += 1;
      await logActivity(
        'LOW_STOCK_ALERT',
        `Low stock: "${product.title}" — ${product.inventory} remaining (threshold: 5).`,
        'WARNING'
      );
    }
  }
  return { alertsCreated, lowStockCount: lowStock.length };
}

export async function generateSingleDescription(product, options = {}) {
  /** @type {'mock' | 'gemini' | null} */
  const mode = (() => {
    const key = process.env.GEMINI_API_KEY;
    if (!key || key.startsWith('placeholder')) return 'mock';
    return 'gemini';
  })();

  if (mode === 'mock') {
    const prompt = buildDescriptionPrompt(product, options);
    const promptLength = prompt.length;

    // Mock description for development
    const mockDesc = `Introducing ${product.title} — a premium product from ${product.vendor || 'our collection'}. Crafted with attention to detail, this item delivers exceptional quality and performance that discerning customers demand. Whether for personal use or as a thoughtful gift, it stands out from the rest.\n\nKey highlights:\n• Superior build quality and lasting durability\n• Designed for everyday reliability and ease of use\n• Backed by our commitment to customer satisfaction\n\nAdd ${product.title} to your cart today and experience the difference quality makes. Limited stock available — order now and enjoy fast, reliable shipping.`;

    const { rows: inserted } = await query(`
      INSERT INTO descriptions (product_id, generated_description, approved, generated_at)
      VALUES ($1, $2, FALSE, NOW())
      ON CONFLICT DO NOTHING
      RETURNING *
    `, [product.id, mockDesc]);

    if (inserted.length) {
      await logActivity(
        'AI_GENERATION',
        `Generated description for "${product.title}" (mock mode). prompt_len=${promptLength} gen_len=${mockDesc.length}`,
        'SUCCESS'
      );
    }
    return inserted.length ? { ...inserted[0], product_title: product.title } : null;
  }

  // Real Gemini call
  const prompt = buildDescriptionPrompt(product, options);
  const promptLength = prompt.length;

  const generatedText = await generateWithGemini(prompt);
  const generatedLength = generatedText.length;

  const { rows: inserted } = await query(`
    INSERT INTO descriptions (product_id, generated_description, approved, generated_at)
    VALUES ($1, $2, FALSE, NOW())
    ON CONFLICT DO NOTHING
    RETURNING *
  `, [product.id, generatedText]);

  await logActivity(
    'AI_GENERATION',
    `Generated AI description for "${product.title}". prompt_len=${promptLength} gen_len=${generatedLength} model=${process.env.GEMINI_MODEL_NAME || 'gemini-1.5-flash'}`,
    'SUCCESS'
  );

  return { ...inserted[0], product_title: product.title };
}

// ──────────────────────────────────────────────
// Order notification engine
// ──────────────────────────────────────────────

function buildOrderEmailHtml(order) {
  const total = Number(order.total).toFixed(2);
  return `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:20px;background:#fff;border-radius:8px;">
    <div style="background:#6366f1;color:#fff;padding:20px;border-radius:8px 8px 0 0;text-align:center;">
      <h2 style="margin:0;font-size:20px;">Order Confirmed</h2>
    </div>
    <div style="padding:20px;">
      <p>Hi <strong>${order.customer_name || 'Valued Customer'}</strong>,</p>
      <p>Your order <strong>#${order.shopify_order_id}</strong> has been received and is being processed.</p>
      <table style="width:100%;border-collapse:collapse;margin:16px 0;">
        <tr><td style="padding:10px 0;border-bottom:1px solid #eee;color:#666;">Order Total</td><td style="padding:10px 0;border-bottom:1px solid #eee;text-align:right;font-weight:bold;">$${total}</td></tr>
        <tr><td style="padding:10px 0;border-bottom:1px solid #eee;color:#666;">Status</td><td style="padding:10px 0;border-bottom:1px solid #eee;text-align:right;text-transform:capitalize;">${order.status}</td></tr>
      </table>
      <p style="color:#666;font-size:14px;">We'll notify you when your order ships. If you have any questions, feel free to reply to this email.</p>
    </div>
    <div style="padding:16px 20px;border-top:1px solid #eee;text-align:center;color:#999;font-size:12px;">
      WeSee E-Commerce Autopilot &middot; Shopify Operations
    </div>
  </div>`;
}

export async function sendOrderNotifications() {
  // Get unnotified orders with retries < 3
  const { rows: unnotified } = await query(
    `SELECT * FROM orders WHERE notification_status = 'UNNOTIFIED' AND notification_retries < 3
     ORDER BY created_at ASC LIMIT 50`
  );

  if (!unnotified.length) {
    return { sent: 0, failed: 0, total: 0 };
  }

  let sent = 0;
  let failed = 0;

  for (const order of unnotified) {
    // Skip orders without an email address
    if (!order.email) {
      await query(
        `UPDATE orders SET notification_status = 'FAILED', notification_retries = notification_retries + 1
         WHERE id = $1`,
        [order.id]
      );
      failed += 1;
      await logActivity(
        'ORDER_NOTIFICATION',
        `Skipped order #${order.shopify_order_id}: no email address.`,
        'WARNING'
      );
      continue;
    }

    try {
      await sendEmailNotification(order);

      // Success: mark as notified
      await query(
        `UPDATE orders SET notification_status = 'NOTIFIED', notification_retries = notification_retries + 1
         WHERE id = $1`,
        [order.id]
      );
      sent += 1;
      await logActivity(
        'ORDER_NOTIFICATION',
        `Notification sent for order #${order.shopify_order_id} to ${order.email}.`,
        'SUCCESS'
      );
    } catch (err) {
      const newRetries = (order.notification_retries || 0) + 1;
      const newStatus = newRetries >= 3 ? 'FAILED' : 'UNNOTIFIED';

      await query(
        `UPDATE orders SET notification_retries = $1, notification_status = $2 WHERE id = $3`,
        [newRetries, newStatus, order.id]
      );
      failed += 1;
      await logActivity(
        'ORDER_NOTIFICATION',
        `Failed to notify order #${order.shopify_order_id} (attempt ${newRetries}/3): ${err.message}`,
        'ERROR'
      );
    }
  }

  return { sent, failed, total: unnotified.length };
}

async function sendEmailNotification(order) {
  const mailtrapToken = process.env.MAILTRAP_API_TOKEN;

  if (mailtrapToken) {
    // Real Mailtrap API call
    const response = await fetch('https://send.api.mailtrap.io/api/send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Api-Token': mailtrapToken,
      },
      body: JSON.stringify({
        from: { email: 'orders@wesee-autopilot.com', name: 'WeSee Autopilot' },
        to: [{ email: order.email }],
        subject: `Order Confirmation — #${order.shopify_order_id}`,
        html: buildOrderEmailHtml(order),
        category: 'Order Notification',
      }),
    });
    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      throw new Error(`Mailtrap returned ${response.status}: ${errBody}`);
    }
    return;
  }

  // Mock mode: simulate email send with a small delay
  await new Promise((r) => setTimeout(r, 30));
  console.log(`[Mock Email] To: ${order.email} | Subject: Order Confirmation #${order.shopify_order_id} | Total: $${Number(order.total).toFixed(2)}`);
}

export async function generateMissingDescriptions() {
  const { rows: products } = await query(`
    SELECT p.* FROM products p
    LEFT JOIN descriptions d ON d.product_id = p.id
    WHERE d.id IS NULL
  `);

  if (!products.length) {
    await logActivity('AI_GENERATION_BATCH', 'No products missing descriptions.', 'INFO');
    return { generated: 0, total: 0 };
  }

  let generated = 0;
  const errors = [];

  for (const product of products) {
    try {
      const result = await generateSingleDescription(product);
      if (result) generated += 1;
    } catch (err) {
      errors.push({ productId: product.id, title: product.title, error: err.message });
      console.error(`[DescriptionGen] Failed for "${product.title}":`, err.message);
    }
  }

  await logActivity(
    'AI_GENERATION_BATCH',
    `Batch complete: ${generated}/${products.length} generated, ${errors.length} error(s).`,
    errors.length ? 'WARNING' : 'SUCCESS'
  );

  return { generated, total: products.length, errors };
}
