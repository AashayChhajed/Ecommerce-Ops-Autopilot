'use client';

import { useEffect, useState, useCallback } from 'react';
import { ClipboardList, RefreshCcw, Search, Download } from 'lucide-react';
import { fetchActivityLogs } from '@/lib/api';
import { ActivityLog } from '@/types/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';

const LOG_TYPES = ['ALL', 'PRODUCT_SYNC', 'ORDER_SYNC', 'LOW_STOCK_ALERT', 'AI_GENERATION', 'DESCRIPTION_APPROVED', 'FULL_SYNC', 'SCHEDULER_SHOPIFYSYNCJOB', 'SCHEDULER_INVENTORYAUDITJOB', 'SERVER_ERROR'];

const statusColor: Record<string, string> = {
  SUCCESS: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20',
  WARNING: 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20',
  ERROR: 'bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-500/20',
  INFO: 'bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20',
};

const statusDot: Record<string, string> = {
  SUCCESS: 'bg-emerald-500',
  WARNING: 'bg-amber-500',
  ERROR: 'bg-rose-500',
  INFO: 'bg-blue-500',
};

export default function LogsPage() {
  const [logs, setLogs] = useState<ActivityLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState('ALL');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await fetchActivityLogs({ limit: 200 });
      setLogs(data);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const filtered = logs.filter((l) => {
    const matchType = typeFilter === 'ALL' || l.type === typeFilter;
    const matchSearch = !search || l.message.toLowerCase().includes(search.toLowerCase()) || l.type.toLowerCase().includes(search.toLowerCase());
    return matchType && matchSearch;
  });

  const exportJson = () => {
    const blob = new Blob([JSON.stringify(filtered, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `activity-logs-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const successCount = logs.filter((l) => l.status === 'SUCCESS').length;
  const errorCount = logs.filter((l) => l.status === 'ERROR').length;
  const warningCount = logs.filter((l) => l.status === 'WARNING').length;

  return (
    <div className="space-y-6">
      {/* Hero header */}
      <Card className="border-primary/10">
        <CardContent className="p-6">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <Badge variant="info" className="mb-2">Audit Trail</Badge>
              <h1 className="text-2xl font-bold tracking-tight">Activity Logs</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                {logs.length} total · {successCount} success · {warningCount} warnings · {errorCount} errors
              </p>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={exportJson}>
                <Download className="h-4 w-4" /> Export
              </Button>
              <Button size="sm" onClick={load} disabled={loading}>
                <RefreshCcw className={cn('h-4 w-4', loading && 'animate-spin')} /> Refresh
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Filters */}
      <div className="flex flex-wrap gap-3">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="text"
            placeholder="Search logs..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        <select
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value)}
          className="flex h-9 rounded-[calc(var(--radius)-2px)] border border-input bg-transparent px-3 py-1 text-sm shadow-xs"
        >
          {LOG_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
      </div>

      {/* Log stream */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between border-b border-border/60 px-5 py-3">
          <CardTitle className="text-xs font-medium text-muted-foreground">{filtered.length} entries</CardTitle>
          <span className="flex items-center gap-1.5 text-xs text-emerald-500">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse-soft" /> Live
          </span>
        </CardHeader>
        <CardContent className="p-0">
          <div className="max-h-[600px] overflow-y-auto">
            {loading ? (
              <div className="space-y-2 p-4">
                {Array.from({ length: 8 }).map((_, i) => (
                  <div key={i} className="flex gap-4 rounded-xl px-3 py-3">
                    <div className="h-2 w-2 mt-1 animate-pulse rounded-full bg-muted" />
                    <div className="flex-1 space-y-1.5">
                      <div className="h-3 w-1/4 animate-pulse rounded bg-muted" />
                      <div className="h-3 w-3/4 animate-pulse rounded bg-muted" />
                    </div>
                  </div>
                ))}
              </div>
            ) : filtered.length === 0 ? (
              <div className="flex flex-col items-center py-12 text-center">
                <ClipboardList className="mb-3 h-8 w-8 text-muted-foreground/50" />
                <p className="text-sm text-muted-foreground">No logs match your filter.</p>
              </div>
            ) : (
              <div className="p-2 space-y-0.5">
                {filtered.map((log) => (
                  <div key={log.id} className="group flex gap-3 rounded-lg px-3 py-2.5 transition-colors hover:bg-muted/50">
                    <span className={cn('mt-1.5 inline-block h-2 w-2 shrink-0 rounded-full', statusDot[log.status] ?? 'bg-muted-foreground')} />
                    <div className="flex-1 min-w-0">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <Badge variant={log.status === 'ERROR' ? 'destructive' : log.status === 'WARNING' ? 'warning' : log.status === 'SUCCESS' ? 'success' : 'secondary'} className="text-[10px] px-1.5 py-0">{log.status}</Badge>
                        <span className="rounded-md bg-muted/60 px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground">{log.type}</span>
                      </div>
                      <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{log.message}</p>
                    </div>
                    <time className="shrink-0 text-[10px] text-muted-foreground/50 pt-1">
                      {new Date(log.createdAt).toLocaleTimeString()}
                    </time>
                  </div>
                ))}
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
