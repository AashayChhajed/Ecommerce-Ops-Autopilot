'use client';

import React, { useEffect, useState, useCallback } from 'react';
import {
  Bell, RefreshCcw, AlertTriangle, CheckCircle2, PackageX,
  Warehouse, ShoppingBag, Store, Globe, Layers, Edit3,
  Save, X, ChevronDown, ChevronUp, RotateCcw, Lock, PackageOpen, ShieldCheck, Search, Tag
} from 'lucide-react';
import {
  fetchUnifiedInventory, fetchInventoryAlerts,
  syncMockChannel, syncAllChannels,
  updateWarehouseQuantity, updateMockChannelQuantity, triggerShopifySync,
  reconcileChannelListings, fetchSafetyBuffer, updateSafetyBuffer,
} from '@/lib/api';
import { UnifiedInventoryItem, InventoryAlert } from '@/types/api';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { Input } from '@/components/ui/input';
import ProductThumb from '@/components/ProductThumb';
import { cn } from '@/lib/utils';

type RiskFilter = 'ALL' | 'OK' | 'OVERSELL_RISK' | 'CHANNEL_MISMATCH';

const riskConfig: Record<string, { label: string; className: string }> = {
  OK: { label: 'OK', className: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20' },
  OVERSELL_RISK: { label: 'Oversell Risk', className: 'bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-500/20' },
  CHANNEL_MISMATCH: { label: 'Channel Mismatch', className: 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20' },
};

function DetailBox({ icon: Icon, iconClass, label, value, sub }: { icon: React.ElementType; iconClass: string; label: string; value: number; sub: string }) {
  return (
    <div className="rounded-lg border border-border/60 bg-muted/30 p-3">
      <div className="mb-1.5 flex items-center gap-2 text-[10px] uppercase tracking-wider text-muted-foreground">
        <Icon className={cn('h-3.5 w-3.5', iconClass)} /> {label}
      </div>
      <p className={cn('text-lg font-bold', iconClass)}>{value}</p>
      <p className="mt-0.5 text-[10px] text-muted-foreground/70">{sub}</p>
    </div>
  );
}

function EditableChannelCell({
  item, channel, editValues, setEditValues, onSave,
}: {
  item: UnifiedInventoryItem;
  channel: 'amazonQuantity' | 'myntraQuantity' | 'flipkartQuantity';
  editValues: Record<string, string>;
  setEditValues: (fn: (prev: Record<string, string>) => Record<string, string>) => void;
  onSave: (productId: number, channel: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const qty = item[channel];
  const key = `${channel}-${item.productId}`;

  if (editing) {
    return (
      <span className="inline-flex items-center gap-1">
        <Input type="number" value={editValues[key] ?? qty} onChange={(e) => setEditValues((v) => ({ ...v, [key]: e.target.value }))} className="w-16 h-8 text-xs text-right" />
        <button onClick={async () => { await onSave(item.productId, channel); setEditing(false); }} className="text-emerald-500 hover:text-emerald-400"><Save className="h-3.5 w-3.5" /></button>
        <button onClick={() => setEditing(false)} className="text-muted-foreground hover:text-foreground"><X className="h-3.5 w-3.5" /></button>
      </span>
    );
  }

  return (
    <span className="inline-flex items-center justify-end gap-1.5 cursor-pointer group w-full" onClick={() => { setEditValues((v) => ({ ...v, [key]: String(qty) })); setEditing(true); }}>
      <span className={cn('font-mono', qty > 0 ? '' : 'text-muted-foreground/50')}>{qty}</span>
      <Edit3 className="h-3 w-3 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
    </span>
  );
}

export default function MultiChannelInventoryPage() {
  const [unified, setUnified] = useState<UnifiedInventoryItem[]>([]);
  const [alerts, setAlerts] = useState<InventoryAlert[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState<string | null>(null);
  const [riskFilter, setRiskFilter] = useState<RiskFilter>('ALL');
  const [editingWarehouse, setEditingWarehouse] = useState<number | null>(null);
  const [editValues, setEditValues] = useState<Record<string, string>>({});
  const [expandedProduct, setExpandedProduct] = useState<number | null>(null);
  const [syncResult, setSyncResult] = useState<string | null>(null);
  const [bufferPercent, setBufferPercent] = useState(100);
  const [bufferDraft, setBufferDraft] = useState('100');
  const [savingBuffer, setSavingBuffer] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [bufferOpen, setBufferOpen] = useState(false);

  const load = useCallback(async (quiet = false) => {
    // quiet skips the skeleton state — used for background refreshes (e.g.
    // after saving the safety buffer) so the table never flashes blank.
    if (!quiet) setLoading(true);
    try {
      const [u, a, b] = await Promise.allSettled([fetchUnifiedInventory(), fetchInventoryAlerts(), fetchSafetyBuffer()]);
      if (u.status === 'fulfilled') setUnified(u.value);
      if (a.status === 'fulfilled') setAlerts(a.value);
      if (b.status === 'fulfilled') {
        setBufferPercent(b.value.bufferPercent);
        setBufferDraft(String(b.value.bufferPercent));
      }
    } finally { if (!quiet) setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleSync = async (type: string) => {
    setSyncing(type); setSyncResult(null);
    try {
      const actions: Record<string, () => Promise<any>> = {
        shopify: () => triggerShopifySync(),
        amazon: () => syncMockChannel('amazon-mock'),
        myntra: () => syncMockChannel('myntra-mock'),
        flipkart: () => syncMockChannel('flipkart-mock'),
        all: () => syncAllChannels(),
        reconcile: () => reconcileChannelListings(),
      };
      const res = await actions[type]();
      if (type === 'reconcile') {
        setSyncResult(`Reconciled ${res.adjusted} channel listing(s) to warehouse availability`);
      } else {
        setSyncResult(`${type} synced successfully`);
      }
      await load();
    } catch { setSyncResult(`Failed to sync ${type}`); }
    finally { setSyncing(null); setTimeout(() => setSyncResult(null), 5000); }
  };

  const handleWarehouseSave = async (productId: number) => {
    try {
      const val = editValues[`warehouse-${productId}`];
      if (val !== undefined) { await updateWarehouseQuantity(productId, Number(val)); setSyncResult('Warehouse quantity updated'); }
    } catch (err: any) { setSyncResult(`Failed: ${err.message}`); }
    finally { setEditingWarehouse(null); await load(); setTimeout(() => setSyncResult(null), 3000); }
  };

  const handleChannelEditSave = async (productId: number, channel: string) => {
    try {
      const val = editValues[`${channel}-${productId}`];
      if (val !== undefined) {
        const channelMap: Record<string, 'amazon_mock' | 'myntra_mock' | 'flipkart_mock'> = { amazonQuantity: 'amazon_mock', myntraQuantity: 'myntra_mock', flipkartQuantity: 'flipkart_mock' };
        await updateMockChannelQuantity(channelMap[channel], productId, Number(val));
        setSyncResult(`Updated`);
      }
    } catch (err: any) { setSyncResult(`Failed: ${err.message}`); }
    finally { setEditingWarehouse(null); await load(); setTimeout(() => setSyncResult(null), 5000); }
  };

  const handleSaveBuffer = async () => {
    const pct = Math.max(1, Math.min(100, Number(bufferDraft) || 100));
    setSavingBuffer(true);
    try {
      const res = await updateSafetyBuffer(pct);
      setBufferPercent(res.bufferPercent);
      setBufferDraft(String(res.bufferPercent));
      setSyncResult(`Safety buffer set to ${res.bufferPercent}% — sellable stock is now ${res.bufferPercent}% of warehouse`);
    } catch (err: any) {
      setSyncResult(`Failed: ${err.message}`);
    } finally {
      setSavingBuffer(false);
      await load(true); // quiet refresh — no table skeleton flash
      setTimeout(() => setSyncResult(null), 5000);
    }
  };

  const activeAlerts = alerts.filter((a) => !a.resolved).length;
  const searchTerm = searchQuery.trim().toLowerCase();
  const filtered = unified
    .filter((u) => riskFilter === 'ALL' || u.riskStatus === riskFilter)
    .filter((u) => !searchTerm
      || u.productTitle.toLowerCase().includes(searchTerm)
      || (u.sku ?? '').toLowerCase().includes(searchTerm));
  const oversellCount = unified.filter((u) => u.riskStatus === 'OVERSELL_RISK').length;
  const mismatchCount = unified.filter((u) => u.riskStatus === 'CHANNEL_MISMATCH').length;
  const okCount = unified.filter((u) => u.riskStatus === 'OK').length;

  return (
    <div className="space-y-6">
      <Card className="border-primary/10">
        <CardContent className="p-6">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <Badge variant="info" className="mb-2"><Globe className="h-3 w-3 mr-1" /> Multi-Channel Inventory</Badge>
              <h1 className="text-2xl font-bold tracking-tight">Unified Inventory Dashboard</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                {okCount} OK · {oversellCount} at risk · {mismatchCount} mismatched · {activeAlerts} alerts
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={() => handleSync('shopify')} disabled={syncing !== null}><RefreshCcw className={cn('h-3.5 w-3.5', syncing === 'shopify' && 'animate-spin')} /> Shopify</Button>
              <Button variant="secondary" size="sm" onClick={() => handleSync('amazon')} disabled={syncing !== null}><RefreshCcw className={cn('h-3.5 w-3.5', syncing === 'amazon' && 'animate-spin')} /> Amazon</Button>
              <Button variant="secondary" size="sm" onClick={() => handleSync('myntra')} disabled={syncing !== null}><RefreshCcw className={cn('h-3.5 w-3.5', syncing === 'myntra' && 'animate-spin')} /> Myntra</Button>
              <Button variant="secondary" size="sm" onClick={() => handleSync('flipkart')} disabled={syncing !== null}><RefreshCcw className={cn('h-3.5 w-3.5', syncing === 'flipkart' && 'animate-spin')} /> Flipkart</Button>
              <Button size="sm" onClick={() => handleSync('all')} disabled={syncing !== null}><RotateCcw className={cn('h-3.5 w-3.5', syncing === 'all' && 'animate-spin')} /> Sync All</Button>
              <Button variant="outline" size="sm" onClick={() => handleSync('reconcile')} disabled={syncing !== null}><Layers className={cn('h-3.5 w-3.5', syncing === 'reconcile' && 'animate-pulse')} /> Reconcile Listings</Button>
            </div>
          </div>
          {syncResult && <div className="mt-3 animate-slide-down rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-4 py-2 text-xs text-emerald-600 dark:text-emerald-400">{syncResult}</div>}
        </CardContent>
      </Card>

      {/* Safety buffer control — collapsed by default, expands on click to save space */}
      <Card className="border-amber-500/20 bg-gradient-to-r from-amber-500/[0.04] to-transparent">
        <button
          type="button"
          onClick={() => setBufferOpen((v) => !v)}
          aria-expanded={bufferOpen}
          className="flex w-full items-center justify-between gap-3 rounded-lg p-5 text-left transition-colors hover:bg-amber-500/[0.03] focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-amber-500/10">
              <ShieldCheck className="h-5 w-5 text-amber-500" />
            </div>
            <div>
              <h2 className="text-sm font-semibold">Over-Order Safety Buffer</h2>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {bufferOpen
                  ? 'Sellable stock is a % of warehouse stock — tune it below'
                  : `Sellable stock is currently ${bufferPercent}% of warehouse. Click to view details.`}
              </p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2.5">
            <span className="rounded-full border border-amber-500/20 bg-amber-500/10 px-2.5 py-0.5 text-xs font-bold text-amber-600 dark:text-amber-400">{bufferPercent}%</span>
            {bufferOpen ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
          </div>
        </button>
        {bufferOpen && (
          <div className="animate-fade-in border-t border-border/60 p-5 pt-4">
            <p className="mb-4 max-w-xl text-xs text-muted-foreground">
              The guard only sells <strong className="text-foreground">{bufferPercent}%</strong> of warehouse stock
              (available = floor(warehouse × {bufferPercent}%) − reserved). Reserving a buffer means returns,
              damage and in-transit units never push you into a stockout — and it protects your seller rating
              across all channels.
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <input
                type="range" min={1} max={100} step={1} value={bufferDraft}
                onChange={(e) => setBufferDraft(e.target.value)}
                className="w-36 sm:w-44 accent-amber-500"
                aria-label="Safety buffer percentage"
              />
              <div className="flex items-center gap-1.5">
                <Input
                  type="number" min={1} max={100} value={bufferDraft}
                  onChange={(e) => setBufferDraft(e.target.value)}
                  className="h-8 w-16 text-right"
                />
                <span className="text-sm font-bold text-muted-foreground">%</span>
              </div>
              <Button size="sm" disabled={savingBuffer || Number(bufferDraft) === bufferPercent} onClick={handleSaveBuffer}>
                <Save className="mr-1.5 h-3.5 w-3.5" /> {savingBuffer ? 'Saving…' : 'Save'}
              </Button>
            </div>
          </div>
        )}
      </Card>

      {/* KPI cards */}
      <div className="grid gap-4 sm:grid-cols-4">
        <Card><CardContent className="flex items-center gap-4 p-4"><div className="flex h-10 w-10 items-center justify-center rounded-lg bg-emerald-500/10"><CheckCircle2 className="h-5 w-5 text-emerald-500" /></div><div><p className="text-[10px] uppercase tracking-wider text-muted-foreground">Healthy</p><p className="text-xl font-bold text-emerald-500">{okCount}</p></div></CardContent></Card>
        <Card><CardContent className="flex items-center gap-4 p-4"><div className="flex h-10 w-10 items-center justify-center rounded-lg bg-rose-500/10"><AlertTriangle className="h-5 w-5 text-rose-500" /></div><div><p className="text-[10px] uppercase tracking-wider text-muted-foreground">Oversell Risk</p><p className="text-xl font-bold text-rose-500">{oversellCount}</p></div></CardContent></Card>
        <Card><CardContent className="flex items-center gap-4 p-4"><div className="flex h-10 w-10 items-center justify-center rounded-lg bg-amber-500/10"><PackageX className="h-5 w-5 text-amber-500" /></div><div><p className="text-[10px] uppercase tracking-wider text-muted-foreground">Mismatch</p><p className="text-xl font-bold text-amber-500">{mismatchCount}</p></div></CardContent></Card>
        <Card><CardContent className="flex items-center gap-4 p-4"><div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10"><Warehouse className="h-5 w-5 text-primary" /></div><div><p className="text-[10px] uppercase tracking-wider text-muted-foreground">Total Products</p><p className="text-xl font-bold text-primary">{unified.length}</p></div></CardContent></Card>
      </div>

      {/* Search + risk filter */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative w-full sm:max-w-xs">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search by product name or SKU…"
            className="pl-9 pr-8"
            aria-label="Search products"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery('')}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
              aria-label="Clear search"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {searchTerm && (
            <span className="text-xs text-muted-foreground">{filtered.length} of {unified.length} match{filtered.length === 1 ? '' : 'es'}</span>
          )}
          {(['ALL', 'OK', 'OVERSELL_RISK', 'CHANNEL_MISMATCH'] as RiskFilter[]).map((f) => (
            <button key={f} onClick={() => setRiskFilter(f)}
              className={cn('rounded-lg border px-3 py-1.5 text-xs font-semibold transition-colors', riskFilter === f ? riskConfig[f]?.className + ' border' || '' : 'border-border/60 bg-transparent text-muted-foreground hover:text-foreground hover:border-foreground/30')}>
              {f === 'ALL' ? 'All Products' : f === 'OK' ? '✅ Healthy' : f === 'OVERSELL_RISK' ? '⚠️ Oversell Risk' : '⚠️ Mismatch'}
            </button>
          ))}
        </div>
      </div>

      {/* Main table */}
      <Card>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-[10px]">Product</TableHead>
                <TableHead className="text-[10px]">SKU</TableHead>
                <TableHead className="text-right text-[10px]"><span className="inline-flex items-center gap-1"><Warehouse className="h-3 w-3" /> Warehouse</span></TableHead>
                <TableHead className="text-right text-[10px]"><span className="inline-flex items-center gap-1"><Lock className="h-3 w-3" /> Reserved</span></TableHead>
                <TableHead className="text-right text-[10px]"><span className="inline-flex items-center gap-1"><PackageOpen className="h-3 w-3" /> Available</span></TableHead>
                <TableHead className="text-right text-[10px]"><span className="inline-flex items-center gap-1"><ShoppingBag className="h-3 w-3" /> Shopify</span></TableHead>
                <TableHead className="text-right text-[10px]"><span className="inline-flex items-center gap-1"><Store className="h-3 w-3" /> Amazon</span></TableHead>
                <TableHead className="text-right text-[10px]"><span className="inline-flex items-center gap-1"><Globe className="h-3 w-3" /> Myntra</span></TableHead>
                <TableHead className="text-right text-[10px]"><span className="inline-flex items-center gap-1"><Globe className="h-3 w-3" /> Flipkart</span></TableHead>
                <TableHead className="text-center text-[10px]">Risk</TableHead>
                <TableHead className="text-center"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                Array.from({ length: 5 }).map((_, i) => (
                  <TableRow key={i}>{Array.from({ length: 11 }).map((_, j) => (<TableCell key={j}><div className="h-4 w-full animate-pulse rounded bg-muted" /></TableCell>))}</TableRow>
                ))
              ) : filtered.length === 0 ? (
                <TableRow><TableCell colSpan={11} className="py-12 text-center text-muted-foreground"><Search className="mx-auto mb-2 h-8 w-8 text-muted-foreground/40" /> {searchTerm ? `No products match “${searchQuery.trim()}”` : 'No products found'}</TableCell></TableRow>
              ) : (
                filtered.map((item) => {
                  const risk = riskConfig[item.riskStatus];
                  const isExpanded = expandedProduct === item.productId;
                  return (
                    <React.Fragment key={item.productId}>
                      <TableRow className={cn(item.riskStatus !== 'OK' && 'bg-destructive/[0.02]')}>
                        <TableCell className="max-w-[220px]">
                          <div className="flex items-center gap-2.5">
                            <ProductThumb src={item.imageUrl} title={item.productTitle} />
                            <p className="min-w-0 font-medium truncate" title={item.productTitle}>{item.productTitle}</p>
                          </div>
                        </TableCell>
                        <TableCell className="font-mono text-xs text-muted-foreground">{item.sku || '—'}</TableCell>
                        <TableCell className="text-right">
                          {editingWarehouse === item.productId ? (
                            <span className="inline-flex items-center gap-1">
                              <Input type="number" value={editValues[`warehouse-${item.productId}`] ?? item.warehouseQuantity} onChange={(e) => setEditValues((v) => ({ ...v, [`warehouse-${item.productId}`]: e.target.value }))} className="w-16 h-8 text-xs text-right" />
                              <button onClick={() => handleWarehouseSave(item.productId)} className="text-emerald-500 hover:text-emerald-400"><Save className="h-3.5 w-3.5" /></button>
                              <button onClick={() => setEditingWarehouse(null)} className="text-muted-foreground hover:text-foreground"><X className="h-3.5 w-3.5" /></button>
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1.5 cursor-pointer group" onClick={() => { setEditingWarehouse(item.productId); setEditValues((v) => ({ ...v, [`warehouse-${item.productId}`]: String(item.warehouseQuantity) })); }}>
                              <span className={cn('font-mono font-bold', item.warehouseQuantity === 0 && 'text-rose-500')}>{item.warehouseQuantity}</span>
                              <Edit3 className="h-3 w-3 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          <span className={cn('font-mono', item.reservedQuantity > 0 ? 'text-amber-500' : 'text-muted-foreground/50')}>{item.reservedQuantity}</span>
                        </TableCell>
                        <TableCell className="text-right">
                          <span className={cn('font-mono font-bold', item.availableQuantity === 0 ? 'text-rose-500' : item.reservedQuantity > 0 ? 'text-amber-500' : 'text-emerald-500')}>{item.availableQuantity}</span>
                        </TableCell>
                        <TableCell className="text-right font-mono">{item.shopifyQuantity}</TableCell>
                        <TableCell className="text-right"><EditableChannelCell item={item} channel="amazonQuantity" editValues={editValues} setEditValues={setEditValues} onSave={handleChannelEditSave} /></TableCell>
                        <TableCell className="text-right"><EditableChannelCell item={item} channel="myntraQuantity" editValues={editValues} setEditValues={setEditValues} onSave={handleChannelEditSave} /></TableCell>
                        <TableCell className="text-right"><EditableChannelCell item={item} channel="flipkartQuantity" editValues={editValues} setEditValues={setEditValues} onSave={handleChannelEditSave} /></TableCell>
                        <TableCell className="text-center">
                          <span className={cn('inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider', risk.className)}>
                            {item.riskStatus === 'OK' && <CheckCircle2 className="h-3 w-3" />}
                            {item.riskStatus === 'OVERSELL_RISK' && <AlertTriangle className="h-3 w-3" />}
                            {item.riskStatus === 'CHANNEL_MISMATCH' && <PackageX className="h-3 w-3" />}
                            {risk.label}
                          </span>
                        </TableCell>
                        <TableCell className="text-center">
                          <button onClick={() => setExpandedProduct(isExpanded ? null : item.productId)} className="text-muted-foreground hover:text-foreground transition-colors">
                            {isExpanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                          </button>
                        </TableCell>
                      </TableRow>
                      {isExpanded && (
                        <TableRow className="bg-muted/20">
                          <TableCell colSpan={11} className="p-4">
                            <div className="animate-fade-in rounded-lg border border-border/60 bg-card p-5">
                              <div className="mb-4 flex items-center justify-between">
                                <h3 className="text-sm font-semibold">{item.productTitle}</h3>
                                <span className={cn('inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider', risk.className)}>{risk.label}</span>
                              </div>
                              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                                <DetailBox icon={Warehouse} iconClass="text-primary" label="Warehouse" value={item.warehouseQuantity} sub="Physical inventory" />
                                <DetailBox icon={Lock} iconClass="text-amber-500" label="Reserved" value={item.reservedQuantity} sub="Committed to accepted orders" />
                                <DetailBox icon={PackageOpen} iconClass={item.availableQuantity === 0 ? 'text-rose-500' : 'text-emerald-500'} label="Available" value={item.availableQuantity} sub="Sellable right now" />
                                <DetailBox icon={Tag} iconClass="text-sky-500" label="Unit Price" value={item.unitPrice} sub="Per unit" />
                                <DetailBox icon={ShoppingBag} iconClass="text-emerald-500" label="Shopify" value={item.shopifyQuantity} sub="Storefront" />
                                <DetailBox icon={Store} iconClass="text-amber-500" label="Amazon" value={item.amazonQuantity} sub="Mock marketplace" />
                                <DetailBox icon={Globe} iconClass="text-violet-500" label="Myntra" value={item.myntraQuantity} sub="Mock marketplace" />
                                <DetailBox icon={Globe} iconClass="text-cyan-500" label="Flipkart" value={item.flipkartQuantity} sub="Mock marketplace" />
                              </div>
                              <div className="mt-4 rounded-lg border border-border/60 bg-muted/30 p-4">
                                <p className="text-xs text-muted-foreground">
                                  <strong className="text-foreground">Risk Assessment:</strong>{' '}
                                  {item.riskStatus === 'OK' && 'Channel quantities are within the sellable stock the guard allows. No overselling risk.'}
                                  {item.riskStatus === 'OVERSELL_RISK' && `Total channel quantity (${item.totalChannelQuantity}) exceeds available stock (${item.availableQuantity}). If all channels sell simultaneously, you'll oversell by ${item.totalChannelQuantity - item.availableQuantity} units.`}
                                  {item.riskStatus === 'CHANNEL_MISMATCH' && `Warehouse shows 0 stock but ${item.totalChannelQuantity} units are still listed across channels. These listings should be paused or updated.`}
                                </p>
                              </div>
                            </div>
                          </TableCell>
                        </TableRow>
                      )}
                    </React.Fragment>
                  );
                })
              )}
            </TableBody>
          </Table>
        </div>
      </Card>
    </div>
  );
}
