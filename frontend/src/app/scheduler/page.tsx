'use client';

import { useEffect, useState, useCallback } from 'react';
import { CalendarClock, RefreshCcw, CheckCircle2, XCircle, Clock, Play } from 'lucide-react';
import { fetchSchedulerStatus, fetchSchedulerRuns, triggerShopifySync } from '@/lib/api';
import { SchedulerRun } from '@/types/api';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { cn } from '@/lib/utils';

function StatusIcon({ status }: { status: string }) {
  if (status === 'SUCCESS') return <CheckCircle2 className="h-5 w-5 text-emerald-500" />;
  if (status === 'FAILURE') return <XCircle className="h-5 w-5 text-rose-500" />;
  return <Clock className="h-5 w-5 text-amber-500 animate-pulse" />;
}

const statusBadge: Record<string, string> = {
  SUCCESS: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20',
  FAILURE: 'bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-500/20',
  RUNNING: 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20',
};

function JobCard({ run }: { run: SchedulerRun }) {
  return (
    <Card className={cn('border-l-4', run.status === 'SUCCESS' ? 'border-l-emerald-500' : run.status === 'FAILURE' ? 'border-l-rose-500' : 'border-l-amber-500')}>
      <CardContent className="p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className={cn('flex h-10 w-10 items-center justify-center rounded-xl', run.status === 'SUCCESS' ? 'bg-emerald-500/10' : run.status === 'FAILURE' ? 'bg-rose-500/10' : 'bg-amber-500/10')}>
              <StatusIcon status={run.status} />
            </div>
            <div>
              <p className="font-semibold text-sm">{run.jobName}</p>
              <p className="text-xs text-muted-foreground">
                {run.started ? `Last run: ${new Date(run.started).toLocaleTimeString()}` : 'Never run'}
              </p>
            </div>
          </div>
          <Badge variant={run.status === 'SUCCESS' ? 'success' : run.status === 'FAILURE' ? 'destructive' : 'warning'}>{run.status}</Badge>
        </div>

        {run.durationMs != null && (
          <div className="mt-4 grid grid-cols-2 gap-3">
            <div className="rounded-lg bg-muted/50 p-3">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Duration</p>
              <p className="mt-1 font-mono text-sm font-medium">{run.durationMs}ms</p>
            </div>
            <div className="rounded-lg bg-muted/50 p-3">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Finished</p>
              <p className="mt-1 font-mono text-xs">{run.finished ? new Date(run.finished).toLocaleTimeString() : '—'}</p>
            </div>
          </div>
        )}

        {run.status === 'FAILURE' && run.errorMessage && (
          <div className="mt-3 rounded-lg border border-destructive/20 bg-destructive/5 p-3 text-xs text-destructive">
            <p className="font-semibold mb-1">Error:</p>
            <p className="break-all leading-relaxed">{run.errorMessage}</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default function SchedulerPage() {
  const [latestRuns, setLatestRuns] = useState<SchedulerRun[]>([]);
  const [allRuns, setAllRuns] = useState<SchedulerRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [latest, all] = await Promise.allSettled([
        fetchSchedulerStatus(),
        fetchSchedulerRuns(),
      ]);
      if (latest.status === 'fulfilled') setLatestRuns(latest.value);
      if (all.status === 'fulfilled') setAllRuns(all.value);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleManualSync = async () => {
    setSyncing(true);
    setSyncMsg(null);
    try {
      const res = await triggerShopifySync();
      setSyncMsg({ ok: true, text: res.message });
      await load();
    } catch (err: unknown) {
      setSyncMsg({ ok: false, text: err instanceof Error ? err.message : 'Sync failed' });
    } finally {
      setSyncing(false);
    }
  };

  const successRate = allRuns.length
    ? Math.round((allRuns.filter((r) => r.status === 'SUCCESS').length / allRuns.length) * 100)
    : 0;
  const avgDuration = allRuns.filter((r) => r.durationMs).length
    ? Math.round(allRuns.filter((r) => r.durationMs).reduce((s, r) => s + (r.durationMs ?? 0), 0) / allRuns.filter((r) => r.durationMs).length)
    : 0;

  return (
    <div className="space-y-6">
      {/* Hero */}
      <Card className="border-primary/10">
        <CardContent className="p-6">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <Badge variant="success" className="mb-2">Task Engine</Badge>
              <h1 className="text-2xl font-bold tracking-tight">Scheduler</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                {allRuns.length} total runs · {successRate}% success rate · avg {avgDuration}ms
              </p>
            </div>
            <div className="flex gap-2">
              <Button variant="secondary" size="sm" onClick={handleManualSync} disabled={syncing}>
                <Play className={cn('h-4 w-4', syncing && 'animate-pulse')} />
                {syncing ? 'Running...' : 'Manual Sync'}
              </Button>
              <Button size="sm" onClick={load} disabled={loading}>
                <RefreshCcw className={cn('h-4 w-4', loading && 'animate-spin')} /> Refresh
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {syncMsg && (
        <div className={cn('rounded-lg border px-4 py-3 text-sm', syncMsg.ok ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : 'border-rose-500/20 bg-rose-500/10 text-rose-600 dark:text-rose-400')}>
          {syncMsg.text}
        </div>
      )}

      {/* Job cards */}
      <div>
        <h3 className="mb-4 text-sm font-semibold uppercase tracking-wider text-muted-foreground">Latest Job Runs</h3>
        {loading ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <Card key={i} className="h-36 animate-pulse" />
            ))}
          </div>
        ) : latestRuns.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center py-12 text-center">
              <CalendarClock className="mb-3 h-8 w-8 text-muted-foreground/50" />
              <p className="text-sm text-muted-foreground">No scheduler runs yet. Jobs will start automatically every hour.</p>
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {latestRuns.map((run) => <JobCard key={run.id} run={run} />)}
          </div>
        )}
      </div>

      {/* Run history */}
      {allRuns.length > 0 && (
        <Card>
          <CardHeader className="border-b border-border/60">
            <CardTitle className="text-sm">Run History (Last 50)</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Job</TableHead>
                  <TableHead>Started</TableHead>
                  <TableHead className="text-right">Duration</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {allRuns.map((run) => (
                  <TableRow key={run.id}>
                    <TableCell className="font-medium">{run.jobName}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{new Date(run.started).toLocaleString()}</TableCell>
                    <TableCell className="text-right font-mono text-xs">{run.durationMs ? `${run.durationMs}ms` : '—'}</TableCell>
                    <TableCell>
                      <Badge variant={run.status === 'SUCCESS' ? 'success' : run.status === 'FAILURE' ? 'destructive' : 'warning'}>{run.status}</Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
