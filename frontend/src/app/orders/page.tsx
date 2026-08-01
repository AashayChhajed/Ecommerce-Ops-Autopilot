'use client';

import { useEffect, useState, useCallback } from 'react';
import {
  ShoppingCart, RefreshCcw, Mail, Send, ShieldCheck, ShieldAlert,
  ShieldQuestion, PackageOpen, Truck, Play, X, Undo2,
} from 'lucide-react';
import { fetchOrders, triggerOrderNotifications, intakeOrder, releaseOrder, fulfillOrder, fetchUnifiedInventory } from '@/lib/api';
import { ShopifyOrder, UnifiedInventoryItem, OrderIntakeResponse } from '@/types/api';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from '@/lib/utils';

function NotifBadge({ status }: { status: string }) {
  const map: Record<string, { variant: 'success' | 'warning' | 'destructive'; label: string }> = {
    NOTIFIED: { variant: 'success', label: 'Notified' },
    UNNOTIFIED: { variant: 'warning', label: 'Unnotified' },
    FAILED: { variant: 'destructive', label: 'Failed' },
  };
  const m = map[status] ?? { variant: 'secondary' as const, label: status };
  return <Badge variant={m.variant}>{m.label}</Badge>;
}

function AllocationBadge({ status }: { status: string }) {
  const map: Record<string, { variant: 'success' | 'destructive' | 'warning' | 'secondary' | 'info'; label: string }> = {
    ALLOCATED: { variant: 'success', label: 'Accepted · Stock Reserved' },
    REJECTED: { variant: 'destructive', label: 'Rejected · No Stock' },
    RELEASED: { variant: 'secondary', label: 'Released' },
    FULFILLED: { variant: 'info', label: 'Fulfilled' },
    UNCHECKED: { variant: 'warning', label: 'Unchecked' },
  };
  const m = map[status] ?? { variant: 'secondary' as const, label: status };
  return <Badge variant={m.variant}>{m.label}</Badge>;
}

function OrderStatusBadge({ status }: { status: string }) {
  const map: Record<string, { variant: 'success' | 'warning' | 'destructive' | 'secondary'; label: string }> = {
    paid: { variant: 'success', label: 'Paid' },
    pending: { variant: 'warning', label: 'Pending' },
    refunded: { variant: 'destructive', label: 'Refunded' },
    voided: { variant: 'secondary', label: 'Voided' },
  };
  const m = map[status] ?? { variant: 'secondary' as const, label: status };
  return <Badge variant={m.variant}>{m.label}</Badge>;
}

const CHANNELS = ['AMAZON_MOCK', 'MYNTRA_MOCK', 'FLIPKART_MOCK'] as const;
const CHANNEL_LABELS: Record<string, string> = {
  AMAZON_MOCK: 'Amazon',
  MYNTRA_MOCK: 'Myntra',
  FLIPKART_MOCK: 'Flipkart',
};

export default function OrdersPage() {
  const [orders, setOrders] = useState<ShopifyOrder[]>([]);
  const [inventory, setInventory] = useState<UnifiedInventoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('all');
  const [notifying, setNotifying] = useState(false);
  const [notifResult, setNotifResult] = useState<{ ok: boolean; msg: string } | null>(null);

  // Simulate order panel state
  const [simChannel, setSimChannel] = useState<string>('AMAZON_MOCK');
  const [simProductId, setSimProductId] = useState<string>('');
  const [simQty, setSimQty] = useState('1');
  const [simBusy, setSimBusy] = useState(false);
  const [simResult, setSimResult] = useState<OrderIntakeResponse | null>(null);
  const [simError, setSimError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [data, inv] = await Promise.allSettled([
        fetchOrders(filter !== 'all' ? { status: filter } : undefined),
        fetchUnifiedInventory(),
      ]);
      if (data.status === 'fulfilled') setOrders(data.value);
      if (inv.status === 'fulfilled') setInventory(inv.value);
    } finally { setLoading(false); }
  }, [filter]);

  useEffect(() => { load(); }, [load]);

  const totalRevenue = orders.reduce((s, o) => s + o.total, 0);
  const notifiedCount = orders.filter((o) => o.notificationStatus === 'NOTIFIED').length;
  const allocatedCount = orders.filter((o) => o.allocationStatus === 'ALLOCATED').length;
  const rejectedCount = orders.filter((o) => o.allocationStatus === 'REJECTED').length;

  const handleNotify = async () => {
    setNotifying(true); setNotifResult(null);
    try {
      const res = await triggerOrderNotifications();
      setNotifResult({ ok: true, msg: `Sent: ${res.sent}, Failed: ${res.failed}, Total: ${res.total}` });
      await load();
    } catch (err: unknown) {
      setNotifResult({ ok: false, msg: err instanceof Error ? err.message : 'Notification failed' });
    } finally { setNotifying(false); }
  };

  const handleSimulate = async () => {
    setSimBusy(true); setSimResult(null); setSimError(null);
    try {
      const res = await intakeOrder({
        channel: simChannel,
        items: [{ productId: Number(simProductId), quantity: selectedQuantity }],
        customerName: 'Guard Test Shopper',
        email: 'guard-test@example.com',
        total: selectedOrderTotal,
      });
      setSimResult(res);
      await load();
    } catch (err: unknown) {
      setSimError(err instanceof Error ? err.message : 'Intake failed');
    } finally { setSimBusy(false); }
  };

  const handleRelease = async (orderId: number) => {
    setActionBusy(orderId);
    try { await releaseOrder(orderId); await load(); } finally { setActionBusy(null); }
  };

  const handleFulfill = async (orderId: number) => {
    setActionBusy(orderId);
    try { await fulfillOrder(orderId); await load(); } finally { setActionBusy(null); }
  };

  const selectedProduct = inventory.find((i) => i.productId === Number(simProductId));
  const selectedQuantity = Math.max(1, Number(simQty) || 1);
  const selectedOrderTotal = selectedProduct ? selectedProduct.unitPrice * selectedQuantity : 0;

  return (
    <div className="space-y-6">
      <Card className="border-primary/10">
        <CardContent className="p-6">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <Badge variant="info" className="mb-2"><ShoppingCart className="h-3 w-3 mr-1" /> Order Management</Badge>
              <h1 className="text-2xl font-bold tracking-tight">Orders</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                {orders.length} orders · ${totalRevenue.toFixed(2)} · {allocatedCount} accepted · {rejectedCount} rejected by stock guard
              </p>
            </div>
            <div className="flex gap-2">
              <Button variant="secondary" size="sm" onClick={handleNotify} disabled={notifying}>
                <Send className={cn('h-4 w-4', notifying && 'animate-pulse')} />
                {notifying ? 'Sending...' : 'Send Notifications'}
              </Button>
              <Button size="sm" onClick={load}><RefreshCcw className="h-4 w-4" /> Refresh</Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {notifResult && (
        <div className={cn('animate-slide-down rounded-lg border px-4 py-3 text-sm', notifResult.ok ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : 'border-rose-500/20 bg-rose-500/10 text-rose-600 dark:text-rose-400')}>
          {notifResult.msg}
        </div>
      )}

      {/* Summary + Simulator */}
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="grid gap-4 sm:grid-cols-3 lg:col-span-1">
          {[
            { label: 'Total Orders', value: orders.length, variant: 'info' as const },
            { label: 'Accepted', value: `${allocatedCount}/${orders.length}`, variant: 'success' as const },
            { label: 'Blocked (no stock)', value: rejectedCount, variant: rejectedCount > 0 ? 'destructive' as const : 'success' as const },
          ].map((card) => (
            <Card key={card.label}>
              <CardContent className="p-4">
                <p className="text-xs text-muted-foreground uppercase tracking-wider">{card.label}</p>
                <p className={cn('mt-1.5 text-2xl font-bold', card.variant === 'success' ? 'text-emerald-500' : card.variant === 'info' ? 'text-primary' : 'text-rose-500')}>{card.value}</p>
              </CardContent>
            </Card>
          ))}
        </div>

        {/* Over-Order Guard Simulator */}
        <Card className="lg:col-span-2 border-amber-500/20">
          <CardHeader className="border-b border-border/60 pb-4">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm flex items-center gap-2"><ShieldCheck className="h-4 w-4 text-primary" /> Over-Order Guard Simulator</CardTitle>
              <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Tests warehouse stock before accepting</span>
            </div>
          </CardHeader>
          <CardContent className="p-4">
            <div className="grid gap-3 sm:grid-cols-4">
              <div>
                <Label className="mb-1.5 block text-xs">Channel</Label>
                <Select value={simChannel} onValueChange={setSimChannel}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {CHANNELS.map((c) => <SelectItem key={c} value={c}>{CHANNEL_LABELS[c]}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="sm:col-span-2">
                <Label className="mb-1.5 block text-xs">Product</Label>
                <Select value={simProductId} onValueChange={setSimProductId}>
                  <SelectTrigger><SelectValue placeholder="Pick a product…" /></SelectTrigger>
                  <SelectContent>
                    {inventory.map((i) => (
                      <SelectItem key={i.productId} value={String(i.productId)}>
                        {i.productTitle} · ${i.unitPrice.toFixed(2)} · available {i.availableQuantity}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {selectedProduct && (
                  <p className="mt-1 text-[10px] text-muted-foreground">
                    Warehouse {selectedProduct.warehouseQuantity} · Reserved {selectedProduct.reservedQuantity} · Available {selectedProduct.availableQuantity} · Est. total ${selectedOrderTotal.toFixed(2)}
                  </p>
                )}
              </div>
              <div>
                <Label className="mb-1.5 block text-xs">Qty</Label>
                <Input type="number" min={1} value={simQty} onChange={(e) => setSimQty(e.target.value)} />
              </div>
            </div>
            <div className="mt-3 flex items-center gap-2">
              <Button size="sm" onClick={handleSimulate} disabled={simBusy || !simProductId}>
                <Play className="h-3.5 w-3.5" /> {simBusy ? 'Checking stock…' : 'Simulate Order'}
              </Button>
              {simResult && (
                <div className={cn('flex items-center gap-2 text-xs', simResult.status === 'ALLOCATED' ? 'text-emerald-500' : 'text-rose-500')}>
                  {simResult.status === 'ALLOCATED' ? <ShieldCheck className="h-4 w-4" /> : <ShieldAlert className="h-4 w-4" />}
                  <span className="font-semibold">{simResult.status === 'ALLOCATED' ? 'ACCEPTED — stock reserved' : 'REJECTED — cannot fulfill'}</span>
                </div>
              )}
              {simError && <span className="text-xs text-rose-500">{simError}</span>}
            </div>
            {simResult && simResult.status === 'REJECTED' && simResult.shortfalls.length > 0 && (
              <div className="mt-3 rounded-lg border border-rose-500/20 bg-rose-500/5 p-3 text-xs space-y-1">
                {simResult.shortfalls.map((s, idx) => (
                  <p key={idx} className="text-rose-600 dark:text-rose-400">
                    ⚠ {s.title ?? `Product #${s.productId}`} — requested {s.requested}, only {s.available} available in warehouse
                  </p>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Filter */}
      <div className="flex rounded-lg border border-border/60 bg-card p-1 w-fit gap-0.5">
        {['all', 'paid', 'pending', 'refunded'].map((f) => (
          <button key={f} onClick={() => setFilter(f)}
            className={cn('rounded-md px-3 py-1.5 text-xs font-medium capitalize transition-colors', filter === f ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:text-foreground')}>
            {f}
          </button>
        ))}
      </div>

      {/* Table */}
      <Card>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Order</TableHead>
                <TableHead>Channel</TableHead>
                <TableHead>Customer</TableHead>
                <TableHead className="text-right">Total</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Stock Guard</TableHead>
                <TableHead>Notification</TableHead>
                <TableHead className="text-center">Actions</TableHead>
                <TableHead>Date</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                Array.from({ length: 5 }).map((_, i) => (
                  <TableRow key={i}>
                    {Array.from({ length: 9 }).map((_, j) => (
                      <TableCell key={j}><div className="h-4 animate-pulse rounded bg-muted" /></TableCell>
                    ))}
                  </TableRow>
                ))
              ) : orders.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={9} className="py-12 text-center text-muted-foreground">
                    <ShoppingCart className="mx-auto mb-3 h-8 w-8 text-muted-foreground/50" />
                    No orders found. Sync from Shopify or simulate one with the guard panel above.
                  </TableCell>
                </TableRow>
              ) : (
                orders.map((o) => (
                  <TableRow key={o.id} className={cn(o.allocationStatus === 'REJECTED' && 'bg-destructive/[0.03]')}>
                    <TableCell><span className="font-mono text-xs font-medium text-primary">#{o.id}</span></TableCell>
                    <TableCell><Badge variant="outline" className="text-[10px] font-mono">{o.channelCode}</Badge></TableCell>
                    <TableCell className="text-muted-foreground">{o.customerName ?? '—'}</TableCell>
                    <TableCell className="text-right font-mono font-medium text-emerald-500">${Number(o.total).toFixed(2)}</TableCell>
                    <TableCell><OrderStatusBadge status={o.status} /></TableCell>
                    <TableCell>
                      <div className="flex flex-col items-start gap-1">
                        <AllocationBadge status={o.allocationStatus} />
                        {o.allocationStatus === 'REJECTED' && o.allocationNotes && (
                          <span className="flex items-center gap-1 text-[10px] text-rose-500 max-w-[160px] truncate" title={o.allocationNotes}>
                            <ShieldAlert className="h-3 w-3 shrink-0" /> {o.allocationNotes}
                          </span>
                        )}
                        {o.allocationStatus === 'ALLOCATED' && (
                          <span className="flex items-center gap-1 text-[10px] text-emerald-500"><ShieldCheck className="h-3 w-3" /> {o.itemCount ?? '—'} item(s) reserved</span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell><NotifBadge status={o.notificationStatus ?? 'UNNOTIFIED'} /></TableCell>
                    <TableCell className="text-center">
                      {o.allocationStatus === 'ALLOCATED' && (
                        <div className="flex items-center justify-center gap-1">
                          <button title="Release stock (cancel)" onClick={() => handleRelease(o.id)} disabled={actionBusy === o.id}
                            className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-amber-500/10 hover:text-amber-500">
                            <Undo2 className="h-3.5 w-3.5" />
                          </button>
                          <button title="Fulfill (ship from warehouse)" onClick={() => handleFulfill(o.id)} disabled={actionBusy === o.id}
                            className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-emerald-500/10 hover:text-emerald-500">
                            <Truck className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      )}
                      {o.allocationStatus === 'UNCHECKED' && <ShieldQuestion className="mx-auto h-3.5 w-3.5 text-muted-foreground/50" />}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">{new Date(o.createdAt).toLocaleDateString()}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </Card>
    </div>
  );
}
