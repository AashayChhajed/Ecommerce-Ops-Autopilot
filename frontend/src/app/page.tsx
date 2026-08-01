'use client';

import { useEffect, useState, useCallback } from 'react';
import {
  Activity, DatabaseZap, PackageSearch, ShoppingCart,
  RefreshCcw, Bell, Sparkles, CalendarClock, DollarSign
} from 'lucide-react';
import {
  fetchHealth, fetchKpis, triggerShopifySync
} from '@/lib/api';
import { KpiData } from '@/types/api';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import StatCard from '@/components/StatCard';
import { cn } from '@/lib/utils';

export default function Dashboard() {
  const [health, setHealth] = useState<{ status: string; db: string }>({ status: 'CHECKING', db: 'CHECKING' });
  const [kpis, setKpis] = useState<KpiData | null>(null);
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<{ ok: boolean; msg: string } | null>(null);

  const loadData = useCallback(async () => {
    const [h, k] = await Promise.allSettled([
      fetchHealth(),
      fetchKpis(),
    ]);
    if (h.status === 'fulfilled') {
      setHealth({ status: h.value.status, db: h.value.components?.db?.status ?? 'DOWN' });
    }
    if (k.status === 'fulfilled') setKpis(k.value);
  }, []);

  useEffect(() => {
    loadData();
    const interval = setInterval(loadData, 30_000);
    return () => clearInterval(interval);
  }, [loadData]);

  const handleSync = async () => {
    setIsSyncing(true); setSyncResult(null);
    try {
      const res = await triggerShopifySync();
      setSyncResult({ ok: res.status !== 'FAILED', msg: `${res.message} (${res.durationMs}ms)` });
      await loadData();
    } catch { setSyncResult({ ok: false, msg: 'Sync failed. Check backend logs.' }); }
    finally { setIsSyncing(false); }
  };

  return (
    <div className="space-y-4">
      {/* Hero */}
      <Card className="border-primary/10 overflow-hidden">
        <CardContent className="relative p-5 sm:p-6">
          <div className="absolute -right-20 -top-20 h-40 w-40 rounded-full bg-primary/10 blur-3xl" />
          <div className="relative z-10 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <Badge variant="info"><Sparkles className="h-3 w-3 mr-1" /> Command Center</Badge>
                <span className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
                  <Activity className="h-3 w-3" />
                  API
                  <span className={cn('h-1.5 w-1.5 rounded-full', health.status === 'UP' ? 'bg-emerald-500' : health.status === 'CHECKING' ? 'bg-amber-500' : 'bg-rose-500')} />
                </span>
                <span className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
                  <DatabaseZap className="h-3 w-3" />
                  DB
                  <span className={cn('h-1.5 w-1.5 rounded-full', health.db === 'UP' ? 'bg-emerald-500' : health.db === 'CHECKING' ? 'bg-amber-500' : 'bg-rose-500')} />
                </span>
              </div>
              <h1 className="text-xl font-bold tracking-tight sm:text-2xl">E-Com Autopilot</h1>
              <p className="max-w-xl text-sm leading-relaxed text-muted-foreground">
                Automating e-commerce operations
              </p>
            </div>
            <Button size="lg" onClick={handleSync} disabled={isSyncing} className="shrink-0">
              <RefreshCcw className={cn('h-4 w-4', isSyncing && 'animate-spin')} />
              {isSyncing ? 'Synchronizing...' : 'Sync from Shopify'}
            </Button>
          </div>
        </CardContent>
      </Card>

      {syncResult && (
        <div className={cn('animate-slide-down rounded-lg border px-4 py-3 text-sm', syncResult.ok ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : 'border-rose-500/20 bg-rose-500/10 text-rose-600 dark:text-rose-400')}>
          {syncResult.msg}
        </div>
      )}

      {/* Top KPIs */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <StatCard label="Revenue" value={kpis ? `$${kpis.totalRevenue.toFixed(0)}` : '—'} icon={DollarSign} subtext="Total order value" accent="emerald" />
        <StatCard label="Total Orders" value={kpis?.totalOrders ?? '—'} icon={ShoppingCart} subtext="All time" accent="violet" />
        <StatCard label="Products Synced" value={kpis?.totalProducts ?? '—'} icon={PackageSearch} subtext="From Shopify catalog" accent="indigo" />
        <StatCard label="Active Alerts" value={kpis?.activeAlerts ?? '—'} icon={Bell} subtext={kpis && kpis.activeAlerts > 0 ? 'Needs attention' : 'All clear'} accent={kpis && kpis.activeAlerts > 0 ? 'amber' : 'emerald'} />
        <StatCard label="AI Descriptions" value={kpis ? `${kpis.approvedDescriptions}/${kpis.totalDescriptions}` : '—'} icon={Sparkles} subtext="Approved / Generated" accent="cyan" />
        <StatCard label="Scheduler Runs" value={kpis ? `${kpis.schedulerSuccess}/${kpis.schedulerRuns}` : '—'} icon={CalendarClock} subtext="Successful / Total" accent={kpis && kpis.schedulerRuns > 0 && kpis.schedulerSuccess === kpis.schedulerRuns ? 'emerald' : 'blue'} />
      </div>
    </div>
  );
}
