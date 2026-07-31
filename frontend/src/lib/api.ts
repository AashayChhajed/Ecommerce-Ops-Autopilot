import {
  Product, ShopifyOrder, InventoryAlert, ActivityLog,
  SyncResponse, HealthResponse, KpiData, SchedulerRun, Description,
  DescriptionSettings, DescriptionMetrics, ApproveResponse, PublishResponse,
  BatchGenerateResponse, NotificationResponse,
  UnifiedInventoryItem, MockChannelInventoryResponse,
  SyncChannelResponse, SyncAllResponse,
  WarehouseUpdateResponse, MockChannelUpdateResponse,
  TestEmailOrderResponse, TestEmailLowStockResponse,
  TestEmailOrderPayload, TestEmailLowStockPayload,
  OrderDetail, OrderIntakeRequest, OrderIntakeResponse,
  OrderReleaseResponse, OrderCheckResponse, ReconcileResponse,
  SafetyBufferResponse,
} from '@/types/api';

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:4000';

async function fetchJson<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, { cache: 'no-store', ...options });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}: ${body || res.statusText}`);
  }
  return res.json();
}

export async function fetchHealth(): Promise<HealthResponse> {
  try {
    return await fetchJson<HealthResponse>(`${API_BASE_URL}/actuator/health`);
  } catch {
    return { status: 'DOWN' };
  }
}

export async function fetchKpis(): Promise<KpiData> {
  return fetchJson<KpiData>(`${API_BASE_URL}/api/kpis`);
}

export async function fetchProducts(params?: { search?: string; status?: string }): Promise<Product[]> {
  const qs = new URLSearchParams();
  if (params?.search) qs.set('search', params.search);
  if (params?.status) qs.set('status', params.status);
  return fetchJson<Product[]>(`${API_BASE_URL}/api/products?${qs}`);
}

export async function fetchOrders(params?: { status?: string }): Promise<ShopifyOrder[]> {
  const qs = new URLSearchParams();
  if (params?.status) qs.set('status', params.status);
  return fetchJson<ShopifyOrder[]>(`${API_BASE_URL}/api/orders?${qs}`);
}

export async function fetchOrderDetail(orderId: number): Promise<OrderDetail> {
  return fetchJson<OrderDetail>(`${API_BASE_URL}/api/orders/${orderId}`);
}

export async function intakeOrder(payload: OrderIntakeRequest): Promise<OrderIntakeResponse> {
  return fetchJson<OrderIntakeResponse>(`${API_BASE_URL}/api/orders/intake`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

export async function checkOrderFulfillable(items: Array<{ productId: number; quantity: number }>): Promise<OrderCheckResponse> {
  return fetchJson<OrderCheckResponse>(`${API_BASE_URL}/api/orders/check`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items }),
  });
}

export async function releaseOrder(orderId: number): Promise<OrderReleaseResponse> {
  return fetchJson<OrderReleaseResponse>(`${API_BASE_URL}/api/orders/${orderId}/release`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function fulfillOrder(orderId: number): Promise<OrderReleaseResponse> {
  return fetchJson<OrderReleaseResponse>(`${API_BASE_URL}/api/orders/${orderId}/fulfill`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function fetchInventoryAlerts(lowStockOnly = false): Promise<InventoryAlert[]> {
  return fetchJson<InventoryAlert[]>(`${API_BASE_URL}/api/inventory?lowStockOnly=${lowStockOnly}`);
}

export async function fetchActivityLogs(params?: { type?: string; limit?: number }): Promise<ActivityLog[]> {
  const qs = new URLSearchParams();
  if (params?.type) qs.set('type', params.type);
  if (params?.limit) qs.set('limit', String(params.limit));
  return fetchJson<ActivityLog[]>(`${API_BASE_URL}/api/activity-logs?${qs}`);
}

export async function fetchSchedulerStatus(): Promise<SchedulerRun[]> {
  return fetchJson<SchedulerRun[]>(`${API_BASE_URL}/api/scheduler/status`);
}

export async function fetchSchedulerRuns(): Promise<SchedulerRun[]> {
  return fetchJson<SchedulerRun[]>(`${API_BASE_URL}/api/scheduler/runs`);
}

export async function fetchPendingDescriptions(): Promise<Description[]> {
  return fetchJson<Description[]>(`${API_BASE_URL}/api/descriptions/pending`);
}

export async function generateDescription(productId: number, tone?: string): Promise<Description | { message: string }> {
  return fetchJson<Description | { message: string }>(`${API_BASE_URL}/api/products/${productId}/generate-description`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tone: tone || '' }),
  });
}

export async function approveDescription(descriptionId: number, editedText?: string): Promise<{ status: string; publishedAt: string }> {
  return fetchJson(`${API_BASE_URL}/api/descriptions/approve/${descriptionId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ editedText }),
  });
}

export async function triggerShopifySync(): Promise<SyncResponse> {
  return fetchJson<SyncResponse>(`${API_BASE_URL}/api/shopify/sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function fetchDescriptionSettings(): Promise<DescriptionSettings> {
  return fetchJson<DescriptionSettings>(`${API_BASE_URL}/api/descriptions/settings`);
}

export async function updateDescriptionSettings(settings: Partial<DescriptionSettings>): Promise<DescriptionSettings> {
  return fetchJson<DescriptionSettings>(`${API_BASE_URL}/api/descriptions/settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings),
  });
}

export async function fetchDescriptionMetrics(): Promise<DescriptionMetrics> {
  return fetchJson<DescriptionMetrics>(`${API_BASE_URL}/api/descriptions/metrics`);
}

export async function fetchDescriptions(params?: { status?: string }): Promise<Description[]> {
  const qs = new URLSearchParams();
  if (params?.status) qs.set('status', params.status);
  return fetchJson<Description[]>(`${API_BASE_URL}/api/descriptions?${qs}`);
}

export async function fetchProductDescription(productId: number): Promise<Description | { productId: number; productTitle: string; hasDescription: boolean }> {
  return fetchJson(`${API_BASE_URL}/api/products/${productId}/description`);
}

export async function approveProductDescription(productId: number, editedText?: string, reviewNotes?: string): Promise<ApproveResponse> {
  return fetchJson<ApproveResponse>(`${API_BASE_URL}/api/products/${productId}/description/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ editedText, reviewNotes }),
  });
}

export async function publishDescription(productId: number): Promise<PublishResponse> {
  return fetchJson<PublishResponse>(`${API_BASE_URL}/api/products/${productId}/description/publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function generateMissingDescriptions(): Promise<BatchGenerateResponse> {
  return fetchJson<BatchGenerateResponse>(`${API_BASE_URL}/api/descriptions/batch-generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function triggerOrderNotifications(): Promise<NotificationResponse> {
  return fetchJson<NotificationResponse>(`${API_BASE_URL}/api/orders/notify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
}

// ── Multi-Channel Inventory ─────────────────────────

export async function fetchUnifiedInventory(): Promise<UnifiedInventoryItem[]> {
  return fetchJson<UnifiedInventoryItem[]>(`${API_BASE_URL}/api/inventory/unified`);
}

export async function fetchMockChannelInventory(channel: 'amazon_mock' | 'myntra_mock' | 'flipkart_mock'): Promise<MockChannelInventoryResponse> {
  return fetchJson<MockChannelInventoryResponse>(`${API_BASE_URL}/api/mock-channels/${channel}/inventory`);
}

export async function syncMockChannel(channel: 'amazon-mock' | 'myntra-mock' | 'flipkart-mock'): Promise<SyncChannelResponse> {
  return fetchJson<SyncChannelResponse>(`${API_BASE_URL}/api/inventory/sync/${channel}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function syncAllChannels(): Promise<SyncAllResponse> {
  return fetchJson<SyncAllResponse>(`${API_BASE_URL}/api/inventory/sync-all`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function reconcileChannelListings(): Promise<ReconcileResponse> {
  return fetchJson<ReconcileResponse>(`${API_BASE_URL}/api/inventory/reconcile`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function fetchSafetyBuffer(): Promise<SafetyBufferResponse> {
  return fetchJson<SafetyBufferResponse>(`${API_BASE_URL}/api/inventory/safety-buffer`);
}

export async function updateSafetyBuffer(bufferPercent: number): Promise<SafetyBufferResponse> {
  return fetchJson<SafetyBufferResponse>(`${API_BASE_URL}/api/inventory/safety-buffer`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bufferPercent }),
  });
}

export async function updateWarehouseQuantity(productId: number, quantity: number): Promise<WarehouseUpdateResponse> {
  return fetchJson<WarehouseUpdateResponse>(`${API_BASE_URL}/api/inventory/warehouse/${productId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ quantity }),
  });
}

export async function updateMockChannelQuantity(channel: 'amazon_mock' | 'myntra_mock' | 'flipkart_mock', productId: number, quantity: number): Promise<MockChannelUpdateResponse> {
  return fetchJson<MockChannelUpdateResponse>(`${API_BASE_URL}/api/mock-channels/${channel}/quantity`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ productId, quantity }),
  });
}

// ── Email Testing ─────────────────────────────

export async function sendTestOrderEmail(payload: TestEmailOrderPayload): Promise<TestEmailOrderResponse> {
  return fetchJson<TestEmailOrderResponse>(`${API_BASE_URL}/api/test-email/order`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

export async function sendTestLowStockEmail(payload: TestEmailLowStockPayload): Promise<TestEmailLowStockResponse> {
  return fetchJson<TestEmailLowStockResponse>(`${API_BASE_URL}/api/test-email/low-stock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}
