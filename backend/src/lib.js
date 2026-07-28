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
