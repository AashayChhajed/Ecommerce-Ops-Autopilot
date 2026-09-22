/**
 * Same-origin API proxy.
 *
 * The browser talks ONLY to this Next.js route handler. The route handler
 * (app/api/proxy/[...path]/route.ts) runs server-side, attaches the
 * AUTOPILOT_API_KEY from process.env (never shipped to the client), and
 * forwards the request to the Node backend.
 *
 * The frontend therefore never sees the API key — it just calls /api/proxy/*.
 */

import type {
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

const PROXY_BASE = '/api/proxy';

export class ApiError extends Error {
  code: string;
  status: number;
  fields?: Array<{ path: string; message: string }>;

  constructor(status: number, code: string, message: string, fields?: Array<{ path: string; message: string }>) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.fields = fields;
  }
}

async function fetchJson<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${PROXY_BASE}${path}`, {
    cache: 'no-store',
    ...options,
    headers: {
      ...(options?.body ? { 'Content-Type': 'application/json' } : {}),
      ...options?.headers,
    },
  });

  if (!res.ok) {
    // Parse the standardized backend error envelope: { error: { code, message, fields? } }
    let code = 'UNKNOWN';
    let message = `HTTP ${res.status}`;
    let fields: Array<{ path: string; message: string }> | undefined;
    try {
      const body = await res.json();
      if (body?.error) {
        code = body.error.code ?? code;
        message = body.error.message ?? message;
        fields = body.error.fields;
      }
    } catch {
      /* non-JSON error body — keep defaults */
    }
    throw new ApiError(res.status, code, message, fields);
  }

  return res.json();
}

/** Unwrap `{ data, pagination }` list envelopes; pass through raw arrays. */
export interface Paginated<T> {
  data: T[];
  pagination: { page: number; limit: number; total: number; totalPages: number };
}

function isPaginated<T>(value: unknown): value is Paginated<T> {
  return (
    typeof value === 'object' && value !== null &&
    Array.isArray((value as { data?: unknown }).data) &&
    typeof (value as { pagination?: unknown }).pagination === 'object'
  );
}

export function unwrapList<T>(payload: T[] | Paginated<T>): T[] {
  return isPaginated<T>(payload) ? payload.data : payload;
}

export function unwrapPagination<T>(payload: T[] | Paginated<T>): Paginated<T>['pagination'] | null {
  return isPaginated<T>(payload) ? payload.pagination : null;
}

// ──────────────────────────────────────────────
// Endpoints (paths are forwarded by the proxy route)
// ──────────────────────────────────────────────

export async function fetchHealth(): Promise<HealthResponse> {
  try {
    return await fetchJson<HealthResponse>('/actuator/health');
  } catch {
    return { status: 'DOWN' };
  }
}

export async function fetchKpis(): Promise<KpiData> {
  return fetchJson<KpiData>('/api/kpis');
}

export async function fetchProducts(params?: { search?: string; status?: string }): Promise<Product[]> {
  const qs = new URLSearchParams({ page: '1', limit: '100' });
  if (params?.search) qs.set('search', params.search);
  if (params?.status) qs.set('status', params.status);
  const payload = await fetchJson<Product[] | Paginated<Product>>(`/api/products?${qs}`);
  return unwrapList(payload);
}

export async function fetchOrders(params?: { status?: string }): Promise<ShopifyOrder[]> {
  const qs = new URLSearchParams({ page: '1', limit: '100' });
  if (params?.status) qs.set('status', params.status);
  const payload = await fetchJson<ShopifyOrder[] | Paginated<ShopifyOrder>>(`/api/orders?${qs}`);
  return unwrapList(payload);
}

export async function fetchOrderDetail(orderId: number): Promise<OrderDetail> {
  return fetchJson<OrderDetail>(`/api/orders/${orderId}`);
}

export async function intakeOrder(payload: OrderIntakeRequest): Promise<OrderIntakeResponse> {
  return fetchJson<OrderIntakeResponse>('/api/orders/intake', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function checkOrderFulfillable(items: Array<{ productId: number; quantity: number }>): Promise<OrderCheckResponse> {
  return fetchJson<OrderCheckResponse>('/api/orders/check', {
    method: 'POST',
    body: JSON.stringify({ items }),
  });
}

export async function releaseOrder(orderId: number): Promise<OrderReleaseResponse> {
  return fetchJson<OrderReleaseResponse>(`/api/orders/${orderId}/release`, { method: 'POST' });
}

export async function fulfillOrder(orderId: number): Promise<OrderReleaseResponse> {
  return fetchJson<OrderReleaseResponse>(`/api/orders/${orderId}/fulfill`, { method: 'POST' });
}

export async function fetchInventoryAlerts(lowStockOnly = false): Promise<InventoryAlert[]> {
  const payload = await fetchJson<InventoryAlert[] | Paginated<InventoryAlert>>(
    `/api/inventory?lowStockOnly=${lowStockOnly}&limit=100`
  );
  return unwrapList(payload);
}

export async function fetchActivityLogs(params?: { type?: string; limit?: number }): Promise<ActivityLog[]> {
  const qs = new URLSearchParams({ page: '1', limit: String(params?.limit ?? 50) });
  if (params?.type) qs.set('type', params.type);
  const payload = await fetchJson<ActivityLog[] | Paginated<ActivityLog>>(`/api/activity-logs?${qs}`);
  return unwrapList(payload);
}

export async function fetchSchedulerStatus(): Promise<SchedulerRun[]> {
  return fetchJson<SchedulerRun[]>('/api/scheduler/status');
}

export async function fetchSchedulerRuns(): Promise<SchedulerRun[]> {
  const payload = await fetchJson<SchedulerRun[] | Paginated<SchedulerRun>>('/api/scheduler/runs?limit=50');
  return unwrapList(payload);
}

export async function fetchPendingDescriptions(): Promise<Description[]> {
  const payload = await fetchJson<Description[] | Paginated<Description>>('/api/descriptions/pending?limit=100');
  return unwrapList(payload);
}

export async function generateDescription(productId: number, tone?: string): Promise<Description | { message: string }> {
  return fetchJson(`/api/products/${productId}/generate-description`, {
    method: 'POST',
    body: JSON.stringify({ tone: tone || '' }),
  });
}

export async function approveDescription(descriptionId: number, editedText?: string): Promise<{ status: string; publishedAt: string }> {
  return fetchJson(`/api/descriptions/approve/${descriptionId}`, {
    method: 'POST',
    body: JSON.stringify({ editedText }),
  });
}

export async function triggerShopifySync(): Promise<SyncResponse> {
  return fetchJson<SyncResponse>('/api/shopify/sync', { method: 'POST' });
}

export async function fetchDescriptionSettings(): Promise<DescriptionSettings> {
  return fetchJson<DescriptionSettings>('/api/descriptions/settings');
}

export async function updateDescriptionSettings(settings: Partial<DescriptionSettings>): Promise<DescriptionSettings> {
  return fetchJson<DescriptionSettings>('/api/descriptions/settings', {
    method: 'POST',
    body: JSON.stringify(settings),
  });
}

export async function fetchDescriptionMetrics(): Promise<DescriptionMetrics> {
  return fetchJson<DescriptionMetrics>('/api/descriptions/metrics');
}

export async function fetchDescriptions(params?: { status?: string }): Promise<Description[]> {
  const qs = new URLSearchParams({ page: '1', limit: '100' });
  if (params?.status) qs.set('status', params.status);
  const payload = await fetchJson<Description[] | Paginated<Description>>(`/api/descriptions?${qs}`);
  return unwrapList(payload);
}

export async function fetchProductDescription(productId: number): Promise<Description | { productId: number; productTitle: string; hasDescription: boolean }> {
  return fetchJson(`/api/products/${productId}/description`);
}

export async function approveProductDescription(productId: number, editedText?: string, reviewNotes?: string): Promise<ApproveResponse> {
  return fetchJson<ApproveResponse>(`/api/products/${productId}/description/approve`, {
    method: 'POST',
    body: JSON.stringify({ editedText, reviewNotes }),
  });
}

export async function publishDescription(productId: number): Promise<PublishResponse> {
  return fetchJson<PublishResponse>(`/api/products/${productId}/description/publish`, { method: 'POST' });
}

export async function generateMissingDescriptions(): Promise<BatchGenerateResponse> {
  return fetchJson<BatchGenerateResponse>('/api/descriptions/batch-generate', { method: 'POST' });
}

export async function triggerOrderNotifications(): Promise<NotificationResponse> {
  return fetchJson<NotificationResponse>('/api/orders/notify', { method: 'POST' });
}

// ── Multi-Channel Inventory ─────────────────────────

export async function fetchUnifiedInventory(): Promise<UnifiedInventoryItem[]> {
  return fetchJson<UnifiedInventoryItem[]>('/api/inventory/unified');
}

export async function fetchMockChannelInventory(channel: 'amazon_mock' | 'myntra_mock' | 'flipkart_mock'): Promise<MockChannelInventoryResponse> {
  return fetchJson<MockChannelInventoryResponse>(`/api/mock-channels/${channel}/inventory`);
}

export async function syncMockChannel(channel: 'amazon-mock' | 'myntra-mock' | 'flipkart-mock'): Promise<SyncChannelResponse> {
  return fetchJson<SyncChannelResponse>(`/api/inventory/sync/${channel}`, { method: 'POST' });
}

export async function syncAllChannels(): Promise<SyncAllResponse> {
  return fetchJson<SyncAllResponse>('/api/inventory/sync-all', { method: 'POST' });
}

export async function reconcileChannelListings(): Promise<ReconcileResponse> {
  return fetchJson<ReconcileResponse>('/api/inventory/reconcile', { method: 'POST' });
}

export async function fetchSafetyBuffer(): Promise<SafetyBufferResponse> {
  return fetchJson<SafetyBufferResponse>('/api/inventory/safety-buffer');
}

export async function updateSafetyBuffer(bufferPercent: number): Promise<SafetyBufferResponse> {
  return fetchJson<SafetyBufferResponse>('/api/inventory/safety-buffer', {
    method: 'PUT',
    body: JSON.stringify({ bufferPercent }),
  });
}

export async function updateWarehouseQuantity(productId: number, quantity: number): Promise<WarehouseUpdateResponse> {
  return fetchJson<WarehouseUpdateResponse>(`/api/inventory/warehouse/${productId}`, {
    method: 'POST',
    body: JSON.stringify({ quantity }),
  });
}

export async function updateMockChannelQuantity(channel: 'amazon_mock' | 'myntra_mock' | 'flipkart_mock', productId: number, quantity: number): Promise<MockChannelUpdateResponse> {
  return fetchJson<MockChannelUpdateResponse>(`/api/mock-channels/${channel}/quantity`, {
    method: 'POST',
    body: JSON.stringify({ productId, quantity }),
  });
}

// ── Email Testing ─────────────────────────────

export async function sendTestOrderEmail(payload: TestEmailOrderPayload): Promise<TestEmailOrderResponse> {
  return fetchJson<TestEmailOrderResponse>('/api/test-email/order', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function sendTestLowStockEmail(payload: TestEmailLowStockPayload): Promise<TestEmailLowStockResponse> {
  return fetchJson<TestEmailLowStockResponse>('/api/test-email/low-stock', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}
