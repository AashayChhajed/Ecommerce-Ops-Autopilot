export interface Product {
  id: number;
  shopifyProductId: number;
  title: string;
  description: string | null;
  vendor: string | null;
  status: string | null;
  inventory: number;
  price: number;
  imageUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

export type AllocationStatus = 'UNCHECKED' | 'ALLOCATED' | 'REJECTED' | 'RELEASED' | 'FULFILLED';

export interface ShopifyOrder {
  id: number;
  shopifyOrderId: number | null;
  channelCode: string;
  orderReference: string | null;
  allocationStatus: AllocationStatus;
  allocationNotes: string | null;
  itemCount: number | null;
  customerName: string | null;
  email: string | null;
  status: string;
  total: number;
  notificationStatus: string;
  createdAt: string;
}

export interface OrderItem {
  id: number;
  productId: number;
  channelSku: string | null;
  quantity: number;
  productTitle: string | null;
  productSku: string | null;
}

export interface OrderDetail extends ShopifyOrder {
  items: OrderItem[];
}

export interface OrderIntakeItemInput {
  productId?: number;
  channelSku?: string;
  quantity: number;
}

export interface OrderIntakeRequest {
  channel: string;
  orderReference?: string;
  customerName?: string;
  email?: string;
  status?: string;
  total?: number;
  items: OrderIntakeItemInput[];
}

export interface OrderShortfall {
  productId?: number;
  title?: string;
  sku?: string;
  requested?: number;
  available?: number;
  reason?: string;
}

export interface OrderIntakeResponse {
  orderId: number;
  channelCode: string;
  status: AllocationStatus;
  shortfalls: OrderShortfall[];
  createdAt: string;
}

export interface OrderReleaseResponse {
  status: string;
  changed: boolean;
  releasedItems?: number;
}

export interface OrderCheckResponse {
  ok: boolean;
  shortfalls: OrderShortfall[];
}

export interface ReconcileResponse {
  adjusted: number;
  details: Array<{
    productId: number;
    channel: string;
    channelSku: string;
    old: number;
    new: number;
  }>;
}

export interface SafetyBufferResponse {
  bufferPercent: number;
  updatedAt?: string;
}

export interface InventoryAlert {
  id: number;
  productId: number;
  productTitle?: string | null;
  shopifyProductId?: number | null;
  currentStock: number;
  threshold: number;
  resolved: boolean;
  createdAt: string;
}

export interface ActivityLog {
  id: number;
  type: string;
  message: string;
  status: string;
  createdAt: string;
}

export interface SchedulerRun {
  id: number;
  jobName: string;
  started: string;
  finished: string | null;
  status: string;
  durationMs: number | null;
  errorMessage: string | null;
}

export interface Description {
  id: number;
  productId: number;
  productTitle: string | null;
  vendor: string | null;
  generatedDescription: string;
  descriptionStatus: string;
  approved: boolean;
  reviewNotes: string | null;
  generatedAt: string;
}

export interface DescriptionSettings {
  id: number | null;
  tone: string;
  language: string;
  brandPhrases: string;
  styleNotes: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface DescriptionMetrics {
  totalDescriptions: number;
  pendingCount: number;
  generatedCount: number;
  approvedCount: number;
  publishedCount: number;
  productsWithoutDesc: number;
  lastBatchRun: string | null;
  totalBatchRuns: number;
  totalProductsProcessed: number;
}

export interface ApproveResponse {
  status: string;
  descriptionId: number;
  productId: number;
  approvedAt: string;
}

export interface PublishResponse {
  status: string;
  descriptionId: number;
  productId: number;
  message: string;
  publishedAt: string;
}

export interface KpiData {
  totalProducts: number;
  totalProductValue: number;
  totalInventory: number;
  totalOrders: number;
  totalRevenue: number;
  activeAlerts: number;
  totalDescriptions: number;
  approvedDescriptions: number;
  schedulerRuns: number;
  schedulerSuccess: number;
  allocatedOrders: number;
  rejectedOrders: number;
  reservedUnits: number;
  recentActivity: ActivityLog[];
}

export interface SyncResponse {
  status: string;
  message: string;
  productsSynced: number;
  ordersSynced: number;
  alertsCreated: number;
  listingsReconciled?: number;
  durationMs: number;
}

export interface HealthResponse {
  status: string;
  components?: {
    db?: { status: string };
  };
}

export interface BatchGenerateResponse {
  generated: number;
  skipped: number;
  total: number;
  errors?: Array<{ productId: number; title: string; error: string }>;
  durationMs: number;
}

export interface NotificationResponse {
  sent: number;
  failed: number;
  total: number;
}

// ── Multi-Channel Inventory ─────────────────────────

export interface UnifiedInventoryItem {
  productId: number;
  productTitle: string;
  sku: string | null;
  imageUrl: string | null;
  unitPrice: number;
  warehouseQuantity: number;
  reservedQuantity: number;
  availableQuantity: number;
  shopifyQuantity: number;
  amazonQuantity: number;
  myntraQuantity: number;
  flipkartQuantity: number;
  totalChannelQuantity: number;
  riskStatus: 'OK' | 'OVERSELL_RISK' | 'CHANNEL_MISMATCH';
}

export interface MockChannelProduct {
  id: number;
  channelSku: string;
  externalId: string | null;
  title: string;
  availableQuantity: number;
  internalProductId?: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface MockChannelInventoryResponse {
  channel: string;
  products: MockChannelProduct[];
}

export interface SyncChannelResponse {
  channel: string;
  status: string;
  synced: number;
  updated: number;
  errors: string[];
}

export interface SyncAllResponse {
  syncedChannels: string[];
  details: Record<string, { synced: number; updated: number; errors: string[] }>;
}

export interface WarehouseUpdateResponse {
  productId: number;
  productTitle: string;
  sku: string | null;
  warehouseQuantity: number;
}

export interface MockChannelUpdateResponse {
  channel: string;
  updated: boolean;
  item: MockChannelProduct | null;
}

// ── Email Testing ──────────────────────────────

export interface TestEmailOrderResponse {
  type: 'order';
  sent: boolean;
  mock: boolean;
  messageId: string | null;
  recipient: string;
  orderId: string | number;
  customerName: string;
  status: string;
  total: number;
}

export interface TestEmailLowStockResponse {
  type: 'low-stock';
  sent: boolean;
  mock: boolean;
  messageId: string | null;
  recipient: string;
  productTitle: string;
  sku: string;
  quantity: number;
  threshold: number;
}

export interface TestEmailOrderPayload {
  email?: string;
  orderId?: string | number;
  customerName?: string;
  status?: string;
  total?: number;
}

export interface TestEmailLowStockPayload {
  email?: string;
  productTitle?: string;
  sku?: string;
  quantity?: number;
  threshold?: number;
}
