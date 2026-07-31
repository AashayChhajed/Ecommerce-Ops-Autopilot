'use client';

import { useEffect, useState, useCallback } from 'react';
import {
  Activity, DatabaseZap, PackageSearch, ShoppingCart,
  RefreshCcw, Bell, Sparkles, TrendingUp,
  CalendarClock, DollarSign
} from 'lucide-react';
import {
  fetchHealth, fetchKpis, fetchActivityLogs, triggerShopifySync
} from '@/lib/api';
import { ActivityLog, KpiData } from '@/types/api';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import StatCard from '@/components/StatCard';
import { cn } from '@/lib/utils';

export default function Dashboard() {
  const [health, setHealth] = useState<{ status: string; db: string }>({ status: 'CHECKING', db: 'CHECKING' });
  const [kpis, setKpis] = useState<KpiData | null>(null);
  const [logs, setLogs] = useState<ActivityLog[]>([]);
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<{ ok: boolean; msg: string } | null>(null);

  const loadData = useCallback(async () => {
    const [h, k, l] = await Promise.allSettled([
      fetchHealth(),
      fetchKpis(),
      fetchActivityLogs({ limit: 10 }),
    ]);
    if (h.status === 'fulfilled') {
      setHealth({ status: h.value.status, db: h.value.components?.db?.status ?? 'DOWN' });
    }
    if (k.status === 'fulfilled') setKpis(k.value);
    if (l.status === 'fulfilled') setLogs(l.value);
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

  const statusDot = health.status === 'UP' ? 'bg-emerald-500' : 'bg-rose-500';

  return (
    <div className="space-y-6">
      {/* Hero */}
      <Card className="border-primary/10 overflow-hidden">
        <CardContent className="relative p-6 sm:p-8">
          <div className="absolute -right-20 -top-20 h-40 w-40 rounded-full bg-primary/10 blur-3xl" />
          <div className="relative z-10 flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
            <div className="space-y-3">
              <Badge variant="info" className="mb-2"><Sparkles className="h-3 w-3 mr-1" /> Command Center</Badge>
              <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">E-Commerce Operations Autopilot</h1>
              <p className="max-w-xl text-sm leading-relaxed text-muted-foreground">
                Monitor store health, sync products and orders from Shopify, and track operational KPIs in real time.
              </p>
            </div>
            <Button size="lg" onClick={handleSync} disabled={isSyncing}>
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

      {/* Health + KPI cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Backend API" value={health.status} icon={Activity} subtext="Node.js server" accent={health.status === 'UP' ? 'emerald' : 'rose'} />
        <StatCard label="Database" value={health.db} icon={DatabaseZap} subtext="PostgreSQL" accent={health.db === 'UP' ? 'emerald' : 'rose'} />
        <StatCard label="Products Synced" value={kpis?.totalProducts ?? '—'} icon={PackageSearch} subtext="From Shopify catalog" accent="indigo" />
        <StatCard label="Total Orders" value={kpis?.totalOrders ?? '—'} icon={ShoppingCart} subtext="All time" accent="violet" />
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Revenue" value={kpis ? `$${kpis.totalRevenue.toFixed(0)}` : '—'} icon={DollarSign} subtext="Total order value" accent="emerald" />
        <StatCard label="Active Alerts" value={kpis?.activeAlerts ?? '—'} icon={Bell} subtext={kpis && kpis.activeAlerts > 0 ? 'Needs attention' : 'All clear'} accent={kpis && kpis.activeAlerts > 0 ? 'amber' : 'emerald'} />
        <StatCard label="AI Descriptions" value={kpis ? `${kpis.approvedDescriptions}/${kpis.totalDescriptions}` : '—'} icon={Sparkles} subtext="Approved / Generated" accent="violet" />
        <StatCard label="Scheduler Runs" value={kpis ? `${kpis.schedulerSuccess}/${kpis.schedulerRuns}` : '—'} icon={CalendarClock} subtext="Successful / Total" accent={kpis && kpis.schedulerRuns > 0 && kpis.schedulerSuccess === kpis.schedulerRuns ? 'emerald' : 'cyan'} />
      </div>

      {/* Bottom panels */}
      <div className="grid gap-6 lg:grid-cols-2">
        {/* Recent activity */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between border-b border-border/60">
            <CardTitle className="text-sm">Recent Activity</CardTitle>
            <span className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wider text-emerald-500">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse-soft" /> Live
            </span>
          </CardHeader>
          <CardContent className="p-0">
            {logs.length === 0 ? (
              <div className="flex flex-col items-center py-8 text-center">
                <RefreshCcw className="mb-3 h-8 w-8 text-muted-foreground/50" />
                <p className="text-sm text-muted-foreground">No activity yet. Trigger a sync to get started.</p>
              </div>
            ) : (
              <div className="p-2 space-y-0.5">
                {logs.map((log) => (
                  <div key={log.id} className="group flex items-start gap-3 rounded-lg px-3 py-2.5 text-xs transition-colors hover:bg-muted/50">
                    <span className={cn('mt-1.5 inline-flex h-2 w-2 shrink-0 rounded-full', log.status === 'ERROR' ? 'bg-rose-500 shadow-[0_0_6px_rgba(244,63,94,0.5)]' : log.status === 'WARNING' ? 'bg-amber-500 shadow-[0_0_6px_rgba(251,191,36,0.5)]' : log.status === 'SUCCESS' ? 'bg-emerald-500 shadow-[0_0_6px_rgba(52,211,153,0.5)]' : 'bg-muted-foreground')} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="font-medium text-foreground">{log.type}</p>
                        <Badge variant={log.status === 'ERROR' ? 'destructive' : log.status === 'WARNING' ? 'warning' : log.status === 'SUCCESS' ? 'success' : 'secondary'} className="text-[10px] px-1.5 py-0">{log.status}</Badge>
                      </div>
                      <p className="mt-0.5 truncate text-muted-foreground">{log.message}</p>
                    </div>
                    <time className="shrink-0 text-muted-foreground/50">{new Date(log.createdAt).toLocaleTimeString()}</time>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* KPI Scoreboard */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between border-b border-border/60">
            <CardTitle className="text-sm">KPI Scoreboard</CardTitle>
            <TrendingUp className="h-4 w-4 text-primary" />
          </CardHeader>
          <CardContent className="p-4">
            {!kpis ? (
              <div className="space-y-3">
                {Array.from({ length: 5 }).map((_, i) => (
                  <div key={i} className="flex items-center justify-between rounded-lg bg-muted/30 px-4 py-3">
                    <div className="h-3 w-1/3 animate-pulse rounded bg-muted" />
                    <div className="h-4 w-16 animate-pulse rounded bg-muted" />
                  </div>
                ))}
              </div>
            ) : (
              <div className="space-y-2">
                {[
                  { label: 'Products Synced', value: kpis.totalProducts, color: 'text-primary' },
                  { label: 'Inventory Value', value: `$${kpis.totalProductValue.toFixed(0)}`, color: 'text-violet-500' },
                  { label: 'Total Inventory', value: kpis.totalInventory, color: 'text-cyan-500' },
                  { label: 'Active Alerts', value: kpis.activeAlerts, color: kpis.activeAlerts > 0 ? 'text-amber-500' : 'text-emerald-500' },
                  { label: 'Scheduler Success Rate', value: kpis.schedulerRuns > 0 ? `${Math.round((kpis.schedulerSuccess / kpis.schedulerRuns) * 100)}%` : '—', color: 'text-emerald-500' },
                ].map((row) => (
                  <div key={row.label} className="flex items-center justify-between rounded-lg bg-muted/30 px-4 py-3">
                    <span className="text-xs text-muted-foreground">{row.label}</span>
                    <span className={cn('text-sm font-bold', row.color)}>{row.value}</span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
