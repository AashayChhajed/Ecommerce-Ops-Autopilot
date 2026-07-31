'use client';

import { useState } from 'react';
import { Mail, Send, ShoppingCart, PackageOpen, CheckCircle2, AlertCircle, RefreshCcw } from 'lucide-react';
import { sendTestOrderEmail, sendTestLowStockEmail } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

type SendResult = { ok: boolean; mock: boolean; message: string };

export default function EmailTestPage() {
  const [orderEmail, setOrderEmail] = useState('test@example.com');
  const [orderId, setOrderId] = useState('12345');
  const [customerName, setCustomerName] = useState('Test Customer');
  const [orderStatus, setOrderStatus] = useState('paid');
  const [orderTotal, setOrderTotal] = useState('99.99');

  const [alertEmail, setAlertEmail] = useState('admin@wesee-autopilot.com');
  const [productTitle, setProductTitle] = useState('Test Product');
  const [sku, setSku] = useState('SKU-TEST-001');
  const [quantity, setQuantity] = useState('3');
  const [threshold, setThreshold] = useState('5');

  const [sendingOrder, setSendingOrder] = useState(false);
  const [sendingAlert, setSendingAlert] = useState(false);
  const [orderResult, setOrderResult] = useState<SendResult | null>(null);
  const [alertResult, setAlertResult] = useState<SendResult | null>(null);

  const handleSendOrder = async () => {
    setSendingOrder(true); setOrderResult(null);
    try {
      const res = await sendTestOrderEmail({ email: orderEmail || undefined, orderId: orderId || undefined, customerName: customerName || undefined, status: orderStatus || undefined, total: orderTotal ? Number(orderTotal) : undefined });
      setOrderResult({ ok: res.sent, mock: res.mock, message: res.sent ? `Order email sent to ${res.recipient}${res.mock ? ' (mock mode)' : ' ✅'}` : 'Failed' });
    } catch (err: unknown) {
      setOrderResult({ ok: false, mock: false, message: err instanceof Error ? err.message : 'Request failed' });
    } finally { setSendingOrder(false); }
  };

  const handleSendAlert = async () => {
    setSendingAlert(true); setAlertResult(null);
    try {
      const res = await sendTestLowStockEmail({ email: alertEmail || undefined, productTitle: productTitle || undefined, sku: sku || undefined, quantity: quantity ? Number(quantity) : undefined, threshold: threshold ? Number(threshold) : undefined });
      setAlertResult({ ok: res.sent, mock: res.mock, message: res.sent ? `Low-stock alert sent to ${res.recipient}${res.mock ? ' (mock mode)' : ' ✅'}` : 'Failed' });
    } catch (err: unknown) {
      setAlertResult({ ok: false, mock: false, message: err instanceof Error ? err.message : 'Request failed' });
    } finally { setSendingAlert(false); }
  };

  return (
    <div className="space-y-6">
      <Card className="border-primary/10">
        <CardContent className="p-6">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <Badge variant="info" className="mb-2"><Mail className="h-3 w-3 mr-1" /> Mailtrap Sandbox</Badge>
              <h1 className="text-2xl font-bold tracking-tight">Email Test Dashboard</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                Send sample transactional emails to the Mailtrap sandbox inbox for testing.
                <Badge variant="warning" className="ml-2 text-[10px]">DEV / SANDBOX ONLY</Badge>
              </p>
            </div>
            <div className="rounded-lg border border-border/60 bg-card p-3 text-xs text-muted-foreground">
              <p>SMTP: <span className="font-mono text-foreground">sandbox.smtp.mailtrap.io:2525</span></p>
              <p className="mt-0.5">Status: <span className="text-amber-500">Check send result below</span></p>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Order card */}
        <Card>
          <CardHeader className="border-b border-border/60 bg-gradient-to-r from-violet-500/5 to-indigo-500/5">
            <div className="flex items-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-gradient-to-br from-violet-500 to-indigo-600 text-white shadow-md">
                <ShoppingCart className="h-4 w-4" />
              </div>
              <div>
                <CardTitle className="text-sm">Order Notification</CardTitle>
                <CardDescription>Order confirmation email template</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-4 p-5">
            <div className="space-y-1.5">
              <Label>Recipient Email</Label>
              <Input type="email" value={orderEmail} onChange={(e) => setOrderEmail(e.target.value)} placeholder="test@example.com" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Order ID</Label>
                <Input type="text" value={orderId} onChange={(e) => setOrderId(e.target.value)} className="font-mono" />
              </div>
              <div className="space-y-1.5">
                <Label>Status</Label>
                <select value={orderStatus} onChange={(e) => setOrderStatus(e.target.value)} className="flex h-9 w-full rounded-[calc(var(--radius)-2px)] border border-input bg-transparent px-3 py-1 text-sm shadow-xs">
                  <option value="paid">Paid</option>
                  <option value="pending">Pending</option>
                  <option value="refunded">Refunded</option>
                  <option value="voided">Voided</option>
                </select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Customer Name</Label>
                <Input type="text" value={customerName} onChange={(e) => setCustomerName(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label>Total ($)</Label>
                <Input type="number" step="0.01" value={orderTotal} onChange={(e) => setOrderTotal(e.target.value)} className="font-mono" />
              </div>
            </div>
            <Button className="w-full" onClick={handleSendOrder} disabled={sendingOrder}>
              <Send className={cn('h-4 w-4', sendingOrder && 'animate-pulse')} />
              {sendingOrder ? 'Sending...' : 'Send Test Order Email'}
            </Button>
            {orderResult && (
              <div className={cn('rounded-lg border px-4 py-3 text-sm', orderResult.ok ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : 'border-rose-500/20 bg-rose-500/10 text-rose-600 dark:text-rose-400')}>
                <div className="flex items-start gap-2">
                  {orderResult.ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> : <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />}
                  <span>{orderResult.message}</span>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Low stock card */}
        <Card>
          <CardHeader className="border-b border-border/60 bg-gradient-to-r from-amber-500/5 to-orange-500/5">
            <div className="flex items-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-gradient-to-br from-amber-500 to-orange-600 text-white shadow-md">
                <PackageOpen className="h-4 w-4" />
              </div>
              <div>
                <CardTitle className="text-sm">Low Stock Alert</CardTitle>
                <CardDescription>Inventory warning email template</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-4 p-5">
            <div className="space-y-1.5">
              <Label>Alert Recipient</Label>
              <Input type="email" value={alertEmail} onChange={(e) => setAlertEmail(e.target.value)} placeholder="admin@wesee-autopilot.com" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Product Title</Label>
                <Input type="text" value={productTitle} onChange={(e) => setProductTitle(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label>SKU</Label>
                <Input type="text" value={sku} onChange={(e) => setSku(e.target.value)} className="font-mono" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Current Quantity</Label>
                <Input type="number" value={quantity} onChange={(e) => setQuantity(e.target.value)} className="font-mono" />
              </div>
              <div className="space-y-1.5">
                <Label>Threshold</Label>
                <Input type="number" value={threshold} onChange={(e) => setThreshold(e.target.value)} className="font-mono" />
              </div>
            </div>
            <Button variant="secondary" className="w-full" onClick={handleSendAlert} disabled={sendingAlert}>
              <Send className={cn('h-4 w-4', sendingAlert && 'animate-pulse')} />
              {sendingAlert ? 'Sending...' : 'Send Test Low Stock Alert'}
            </Button>
            {alertResult && (
              <div className={cn('rounded-lg border px-4 py-3 text-sm', alertResult.ok ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : 'border-rose-500/20 bg-rose-500/10 text-rose-600 dark:text-rose-400')}>
                <div className="flex items-start gap-2">
                  {alertResult.ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> : <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />}
                  <span>{alertResult.message}</span>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardContent className="p-5 flex items-start gap-3">
          <RefreshCcw className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          <div className="space-y-1 text-sm text-muted-foreground">
            <p><strong className="text-foreground">How this works:</strong> These endpoints send test emails to the Mailtrap Email Sandbox (via SMTP).</p>
            <p>If SMTP credentials are not configured, the emails will be <strong className="text-amber-500">logged to the backend console</strong> instead (mock mode).</p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
