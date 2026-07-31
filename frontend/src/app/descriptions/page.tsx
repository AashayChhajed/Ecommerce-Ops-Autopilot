'use client';

import { useEffect, useState, useCallback } from 'react';
import {
  Sparkles, RefreshCcw, CheckCircle2, X, Eye, AlertCircle,
  Send, MessageSquare, FileText, Play,
  Filter
} from 'lucide-react';
import {
  fetchDescriptions, fetchDescriptionSettings, fetchDescriptionMetrics,
  generateMissingDescriptions, generateDescription,
  approveProductDescription, publishDescription,
  updateDescriptionSettings, fetchProducts
} from '@/lib/api';
import { Description, DescriptionSettings, DescriptionMetrics, Product } from '@/types/api';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

// ── Status badge ────────────────────────────────────
function DescStatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    pending: 'bg-slate-500/10 text-slate-600 dark:text-slate-400 border-slate-500/20',
    generated: 'bg-violet-500/10 text-violet-600 dark:text-violet-400 border-violet-500/20',
    approved: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20',
    published: 'bg-cyan-500/10 text-cyan-600 dark:text-cyan-400 border-cyan-500/20',
  };
  return <Badge variant="secondary" className={map[status] ?? map.generated}>{status}</Badge>;
}

// ── Approve modal ────────────────────────────────────
function ApproveReviewModal({ description, onApprove, onPublish, onClose }: {
  description: Description;
  onApprove: (editedText: string, reviewNotes: string) => Promise<void>;
  onPublish: () => Promise<void>;
  onClose: () => void;
}) {
  const [text, setText] = useState(description.generatedDescription ?? '');
  const [notes, setNotes] = useState(description.reviewNotes ?? '');
  const [loading, setLoading] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [done, setDone] = useState(false);
  const isApproved = description.descriptionStatus === 'approved' || description.descriptionStatus === 'published';

  const handleApprove = async () => { setLoading(true); try { await onApprove(text, notes); setDone(true); setTimeout(onClose, 1200); } finally { setLoading(false); } };
  const handlePublish = async () => { setPublishing(true); try { await onPublish(); setDone(true); setTimeout(onClose, 1200); } finally { setPublishing(false); } };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
      <div className="animate-slide-down w-full max-w-3xl rounded-xl border bg-card p-6 shadow-2xl">
        <div className="mb-4 flex items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className={cn('flex h-10 w-10 items-center justify-center rounded-lg', isApproved ? 'bg-emerald-500/10' : 'bg-primary/10')}>
              {isApproved ? <CheckCircle2 className="h-5 w-5 text-emerald-500" /> : <Eye className="h-5 w-5 text-primary" />}
            </div>
            <div>
              <h2 className="text-base font-semibold">{isApproved ? 'Approved Description' : 'Review AI Description'}</h2>
              <p className="mt-0.5 text-xs text-muted-foreground">{description.productTitle}</p>
            </div>
          </div>
          <button onClick={onClose} className="rounded-lg p-1.5 text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"><X className="h-4 w-4" /></button>
        </div>

        <label className="mb-1 block text-xs font-medium text-muted-foreground">Description</label>
        <textarea value={text} onChange={(e) => setText(e.target.value)}
          className={cn('flex w-full rounded-lg border border-input bg-transparent p-4 text-sm leading-relaxed resize-none h-44 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50', isApproved && 'opacity-80')}
          placeholder="AI generated description..." readOnly={isApproved} />

        <div className="mt-2 flex items-center justify-between text-xs text-muted-foreground">
          <span>{text.split(/\s+/).filter(Boolean).length} words</span>
          {!isApproved && <span>Edit freely before approving</span>}
        </div>

        {!isApproved && (
          <div className="mt-4">
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Review Notes (optional)</label>
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)}
              className="flex w-full rounded-lg border border-input bg-transparent p-3 text-xs resize-none h-16 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
              placeholder="Add any review notes or feedback..." />
          </div>
        )}

        <div className="mt-5 flex gap-3">
          {isApproved ? (
            <Button className="flex-1" onClick={handlePublish} disabled={publishing || done || description.descriptionStatus === 'published'}>
              {done ? <><CheckCircle2 className="h-4 w-4" /> Published</> : publishing ? <><RefreshCcw className="h-4 w-4 animate-spin" /> Publishing...</> : description.descriptionStatus === 'published' ? <><CheckCircle2 className="h-4 w-4" /> Already Published</> : <><Send className="h-4 w-4" /> Publish to Shopify</>}
            </Button>
          ) : (
            <Button className="flex-1" onClick={handleApprove} disabled={loading || done}>
              {done ? <><CheckCircle2 className="h-4 w-4" /> Approved!</> : loading ? <><RefreshCcw className="h-4 w-4 animate-spin" /> Approving...</> : <><CheckCircle2 className="h-4 w-4" /> Approve & Apply</>}
            </Button>
          )}
          <Button variant="outline" onClick={onClose}>{isApproved ? 'Close' : 'Cancel'}</Button>
        </div>
      </div>
    </div>
  );
}

// ── Brand Voice Panel ────────────────────────────────
function BrandVoicePanel({ settings, onSave }: { settings: DescriptionSettings; onSave: (s: DescriptionSettings) => Promise<void> }) {
  const [local, setLocal] = useState<DescriptionSettings>(settings);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  useEffect(() => setLocal(settings), [settings]);

  const TONES = [
    { value: 'professional', label: 'Professional', desc: 'Confident, benefit-focused language' },
    { value: 'friendly', label: 'Friendly', desc: 'Warm, conversational tone' },
    { value: 'playful', label: 'Playful', desc: 'Energetic, fun language' },
    { value: 'expert', label: 'Expert', desc: 'Technical, authoritative voice' },
  ];

  const handleSave = async () => { setSaving(true); try { await onSave(local); setSaved(true); setTimeout(() => setSaved(false), 2500); } finally { setSaving(false); } };

  return (
    <Card>
      <CardHeader className="border-b border-border/60">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10"><MessageSquare className="h-4 w-4 text-primary" /></div>
          <div><CardTitle className="text-sm">Brand Voice Configuration</CardTitle><p className="text-xs text-muted-foreground">Customize how AI describes your products</p></div>
        </div>
      </CardHeader>
      <CardContent className="pt-6">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-x-8 gap-y-5">
          <div className="space-y-5">
            <div>
              <label className="mb-2 block text-xs font-medium text-muted-foreground">Tone of Voice</label>
              <div className="grid grid-cols-2 gap-2">
                {TONES.map((t) => (
                  <button key={t.value} onClick={() => setLocal((prev) => ({ ...prev, tone: t.value }))}
                    className={cn('rounded-lg border px-3 py-2.5 text-left text-xs transition-all', local.tone === t.value ? 'border-primary/30 bg-primary/10 text-primary ring-1 ring-primary/20' : 'border-border/60 text-muted-foreground hover:bg-accent hover:text-accent-foreground')}>
                    <span className="block font-medium">{t.label}</span>
                    <span className="block text-[10px] text-muted-foreground/70 mt-0.5">{t.desc}</span>
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-medium text-muted-foreground">Language</label>
              <select value={local.language} onChange={(e) => setLocal((prev) => ({ ...prev, language: e.target.value }))}
                className="flex h-9 w-full rounded-[calc(var(--radius)-2px)] border border-input bg-transparent px-3 py-1 text-sm shadow-xs">
                <option value="">Select language…</option><option value="English">English</option><option value="Spanish">Spanish</option><option value="French">French</option><option value="German">German</option><option value="Japanese">Japanese</option><option value="Chinese (Simplified)">Chinese (Simplified)</option>
              </select>
            </div>
          </div>
          <div className="space-y-5">
            <div>
              <label className="mb-1.5 block text-xs font-medium text-muted-foreground">Key Brand Phrases</label>
              <Input type="text" value={local.brandPhrases} onChange={(e) => setLocal((prev) => ({ ...prev, brandPhrases: e.target.value }))} placeholder="e.g., sustainable, handcrafted, premium quality" />
              <p className="mt-1 text-[10px] text-muted-foreground/70">Comma-separated keywords the AI should naturally incorporate</p>
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-medium text-muted-foreground">Style Notes</label>
              <textarea value={local.styleNotes} onChange={(e) => setLocal((prev) => ({ ...prev, styleNotes: e.target.value }))}
                className="flex w-full rounded-lg border border-input bg-transparent p-3 text-sm resize-none h-[102px] focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                placeholder="e.g., Focus on quality, craftsmanship, and customer satisfaction." />
            </div>
          </div>
        </div>
        <div className="mt-6 pt-5 border-t border-border/60">
          <Button onClick={handleSave} disabled={saving} variant={saved ? 'outline' : 'default'}>
            {saving ? <><RefreshCcw className="h-4 w-4 animate-spin" /> Saving...</> : saved ? <><CheckCircle2 className="h-4 w-4" /> Saved</> : <><CheckCircle2 className="h-4 w-4" /> Save Brand Voice</>}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ── Metrics Bar ──────────────────────────────────────
function MetricsBar({ metrics }: { metrics: DescriptionMetrics }) {
  const items = [
    { label: 'Pending', value: metrics.pendingCount },
    { label: 'Generated', value: metrics.generatedCount },
    { label: 'Approved', value: metrics.approvedCount },
    { label: 'Published', value: metrics.publishedCount },
    { label: 'Batch Runs', value: metrics.totalBatchRuns },
    { label: 'Need Desc', value: metrics.productsWithoutDesc },
  ];

  return (
    <div className="rounded-lg border border-border/60 bg-card/70 px-5 py-3">
      <div className="flex items-center divide-x divide-border/60">
        {items.map((s, idx) => (
          <div key={s.label} className={cn('flex items-center gap-3', idx === 0 ? '' : 'pl-5', idx === items.length - 1 ? '' : 'pr-5')}>
            <div>
              <p className="text-lg font-bold tracking-tight text-foreground">{s.value}</p>
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground leading-tight">{s.label}</p>
            </div>
          </div>
        ))}
        {metrics.lastBatchRun && <div className="ml-auto pl-5 text-[10px] text-muted-foreground/50 whitespace-nowrap">Last batch: {new Date(metrics.lastBatchRun).toLocaleString()}</div>}
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────
const STATUS_FILTERS = ['all', 'pending', 'generated', 'approved', 'published'] as const;

export default function DescriptionsPage() {
  const [descriptions, setDescriptions] = useState<Description[]>([]);
  const [settings, setSettings] = useState<DescriptionSettings | null>(null);
  const [metrics, setMetrics] = useState<DescriptionMetrics | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [search, setSearch] = useState('');
  const [batchRunning, setBatchRunning] = useState(false);
  const [generatingSingle, setGeneratingSingle] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [reviewDesc, setReviewDesc] = useState<Description | null>(null);

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [d, s, m, p] = await Promise.allSettled([
        fetchDescriptions({ status: statusFilter === 'all' ? undefined : statusFilter }), fetchDescriptionSettings(), fetchDescriptionMetrics(), fetchProducts(),
      ]);
      if (d.status === 'fulfilled') setDescriptions(d.value);
      if (s.status === 'fulfilled') setSettings(s.value);
      if (m.status === 'fulfilled') setMetrics(m.value);
      if (p.status === 'fulfilled') setProducts(p.value);
    } catch { setError('Failed to load data'); }
    finally { setLoading(false); }
  }, [statusFilter]);

  useEffect(() => { loadAll(); }, [loadAll]);

  const filtered = descriptions.filter((d) => search ? (d.productTitle?.toLowerCase() ?? '').includes(search.toLowerCase()) : true);
  const missingCount = metrics?.productsWithoutDesc ?? 0;

  const handleBatchGenerate = async () => {
    setBatchRunning(true); setError(null); setSuccessMsg(null);
    try {
      const result = await generateMissingDescriptions(); await loadAll();
      const msg = `Batch complete: ${result.generated} generated, ${result.errors?.length ?? 0} errors in ${result.durationMs}ms.`;
      setSuccessMsg(result.generated > 0 ? msg : 'All products already have descriptions.');
    } catch (err: unknown) { setError(err instanceof Error ? err.message : 'Batch generation failed'); }
    finally { setBatchRunning(false); }
  };

  const handleGenerateSingle = async (productId: number) => {
    setGeneratingSingle(productId); setError(null);
    try {
      const tone = settings?.tone || undefined;
      const res = await generateDescription(productId, tone);
      if ('message' in res) setSuccessMsg(res.message);
      await loadAll();
    } catch (err: unknown) { setError(err instanceof Error ? err.message : 'Generation failed'); }
    finally { setGeneratingSingle(null); }
  };

  const handleApprove = async (editedText: string, reviewNotes: string) => {
    if (!reviewDesc) return;
    await approveProductDescription(reviewDesc.productId, editedText, reviewNotes);
    await loadAll();
  };

  const handlePublish = async () => {
    if (!reviewDesc) return;
    await publishDescription(reviewDesc.productId);
    await loadAll();
  };

  const handleSaveBrandVoice = async (s: DescriptionSettings) => {
    await updateDescriptionSettings(s);
    await loadAll();
  };

  return (
    <div className="space-y-6">
      <Card className="border-primary/10">
        <CardContent className="p-6">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <Badge variant="info" className="mb-2"><Sparkles className="h-3 w-3 mr-1" /> AI Description Pipeline</Badge>
              <h1 className="text-2xl font-bold tracking-tight">Description Generator</h1>
              <p className="mt-1 text-sm text-muted-foreground">{descriptions.length} descriptions · {missingCount} products need descriptions</p>
            </div>
            <div className="flex gap-2">
              <Button variant="secondary" size="sm" onClick={handleBatchGenerate} disabled={batchRunning}>
                <Play className={cn('h-4 w-4', batchRunning && 'animate-pulse')} /> {batchRunning ? 'Running Batch...' : 'Run Batch Generation'}
              </Button>
              <Button size="sm" onClick={loadAll} disabled={loading}><RefreshCcw className={cn('h-4 w-4', loading && 'animate-spin')} /> Refresh</Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {successMsg && (
        <div className="animate-slide-down flex items-center gap-2 rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-600 dark:text-emerald-400">
          <CheckCircle2 className="h-4 w-4 shrink-0" /> {successMsg}<button onClick={() => setSuccessMsg(null)} className="ml-auto"><X className="h-4 w-4" /></button>
        </div>
      )}
      {error && (
        <div className="animate-slide-down flex items-center gap-2 rounded-lg border border-destructive/20 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          <AlertCircle className="h-4 w-4 shrink-0" /> {error}<button onClick={() => setError(null)} className="ml-auto"><X className="h-4 w-4" /></button>
        </div>
      )}

      {metrics && <MetricsBar metrics={metrics} />}
      {settings && <BrandVoicePanel settings={settings} onSave={handleSaveBrandVoice} />}

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[200px]">
          <Filter className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input type="text" placeholder="Search by product name..." value={search} onChange={(e) => setSearch(e.target.value)} className="pl-9" />
        </div>
        <div className="flex rounded-lg border border-border/60 bg-card p-1 gap-0.5 overflow-x-auto">
          {STATUS_FILTERS.map((f) => (
            <button key={f} onClick={() => setStatusFilter(f)}
              className={cn('rounded-md px-3 py-1.5 text-xs font-medium capitalize whitespace-nowrap transition-colors', statusFilter === f ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:text-foreground')}>{f}</button>
          ))}
        </div>
        <span className="text-xs text-muted-foreground/50">{filtered.length} result(s)</span>
      </div>

      {/* Table */}
      <Card>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Product</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Description Preview</TableHead>
                <TableHead>Generated</TableHead>
                <TableHead className="text-center">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                Array.from({ length: 6 }).map((_, i) => (
                  <TableRow key={i}>{Array.from({ length: 5 }).map((_, j) => (<TableCell key={j}><div className="h-4 w-full animate-pulse rounded bg-muted" /></TableCell>))}</TableRow>
                ))
              ) : filtered.length === 0 ? (
                <TableRow><TableCell colSpan={5} className="py-12 text-center text-muted-foreground">
                  <FileText className="mx-auto mb-3 h-8 w-8 text-muted-foreground/50" /> Run a batch generation to get started.
                </TableCell></TableRow>
              ) : (
                filtered.map((desc) => (
                  <TableRow key={desc.id}>
                    <TableCell className="max-w-xs">
                      <p className="font-medium truncate">{desc.productTitle ?? `Product #${desc.productId}`}</p>
                      {desc.vendor && <p className="text-xs text-muted-foreground">{desc.vendor}</p>}
                    </TableCell>
                    <TableCell><DescStatusBadge status={desc.descriptionStatus} /></TableCell>
                    <TableCell className="max-w-md"><p className="text-xs text-muted-foreground line-clamp-2 leading-relaxed">{desc.generatedDescription?.slice(0, 200) ?? '—'}</p></TableCell>
                    <TableCell className="text-xs text-muted-foreground whitespace-nowrap">{new Date(desc.generatedAt).toLocaleDateString()}</TableCell>
                    <TableCell className="text-center">
                      <div className="flex items-center justify-center gap-1.5">
                        {desc.descriptionStatus === 'generated' && (
                          <Button variant="outline" size="sm" onClick={() => setReviewDesc(desc)}><Eye className="h-3 w-3" /> Review</Button>
                        )}
                        {(desc.descriptionStatus === 'generated' || desc.descriptionStatus === 'pending') && (
                          <Button variant="ghost" size="sm" onClick={() => handleGenerateSingle(desc.productId)} disabled={generatingSingle === desc.productId}>
                            <RefreshCcw className={cn('h-3 w-3', generatingSingle === desc.productId && 'animate-spin')} />
                          </Button>
                        )}
                        {desc.descriptionStatus === 'approved' && (
                          <Button variant="outline" size="sm" onClick={() => setReviewDesc(desc)}><Eye className="h-3 w-3" /> View</Button>
                        )}
                        {desc.descriptionStatus === 'published' && <Badge variant="success">Published</Badge>}
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </Card>

      {reviewDesc && <ApproveReviewModal description={reviewDesc} onApprove={handleApprove} onPublish={handlePublish} onClose={() => { setReviewDesc(null); loadAll(); }} />}
    </div>
  );
}
