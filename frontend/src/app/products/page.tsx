'use client';

import { useEffect, useState, useCallback } from 'react';
import { Package, Search, RefreshCcw, Sparkles, CheckCircle2, AlertCircle, ChevronDown, X, Eye } from 'lucide-react';
import { fetchProducts, generateDescription, approveDescription, generateMissingDescriptions } from '@/lib/api';
import { Product, Description } from '@/types/api';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { cn } from '@/lib/utils';

type FilterStatus = 'all' | 'active' | 'draft' | 'archived';

const statusBadge: Record<string, string> = {
  active: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20',
  draft: 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20',
  archived: 'bg-slate-500/10 text-slate-600 dark:text-slate-400 border-slate-500/20',
};

const TONE_OPTIONS = [
  { value: '', label: 'Professional (default)', description: 'Confident, benefit-focused language' },
  { value: 'friendly', label: 'Friendly', description: 'Warm, conversational tone' },
  { value: 'playful', label: 'Playful', description: 'Energetic, fun language' },
  { value: 'expert', label: 'Expert', description: 'Technical, authoritative voice' },
] as const;

interface ReviewModalProps {
  description: Description;
  onApprove: (editedText: string) => Promise<void>;
  onClose: () => void;
}

function ReviewModal({ description, onApprove, onClose }: ReviewModalProps) {
  const [text, setText] = useState(description.generatedDescription ?? '');
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);

  const handleApprove = async () => {
    setLoading(true);
    try { await onApprove(text); setDone(true); setTimeout(onClose, 1200); }
    finally { setLoading(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
      <div className="animate-slide-down w-full max-w-2xl rounded-xl border bg-card p-6 shadow-2xl">
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold">Review AI Description</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">{description.productTitle}</p>
          </div>
          <button onClick={onClose} className="rounded-lg p-1.5 text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"><X className="h-4 w-4" /></button>
        </div>
        <textarea value={text} onChange={(e) => setText(e.target.value)}
          className="flex w-full rounded-lg border border-input bg-transparent p-4 text-sm leading-relaxed resize-none h-48 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          placeholder="AI generated description..."
        />
        <div className="mt-2 flex items-center justify-between text-xs text-muted-foreground">
          <span>{text.split(/\s+/).filter(Boolean).length} words</span>
          <span>Edit freely before approving</span>
        </div>
        <div className="mt-5 flex gap-3">
          <Button className="flex-1" onClick={handleApprove} disabled={loading || done}>
            {done ? <><CheckCircle2 className="h-4 w-4" /> Approved & Published</> : loading ? <><RefreshCcw className="h-4 w-4 animate-spin" /> Approving...</> : <><CheckCircle2 className="h-4 w-4" /> Approve & Apply</>}
          </Button>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
        </div>
      </div>
    </div>
  );
}

export default function ProductsPage() {
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<FilterStatus>('all');
  const [generating, setGenerating] = useState<number | null>(null);
  const [batchGenerating, setBatchGenerating] = useState(false);
  const [generatedDesc, setGeneratedDesc] = useState<Description | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [syncResult, setSyncResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const [selectedTone, setSelectedTone] = useState('');
  const [showTonePicker, setShowTonePicker] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try { setProducts(await fetchProducts({ status: filter === 'all' ? undefined : filter })); }
    catch { setError('Failed to load products'); }
    finally { setLoading(false); }
  }, [filter]);

  useEffect(() => { load(); }, [load]);

  const filtered = products.filter((p) => search ? p.title.toLowerCase().includes(search.toLowerCase()) : true);

  const handleGenerate = async (productId: number) => {
    setGenerating(productId); setError(null);
    try {
      const tone = selectedTone || undefined;
      const res = await generateDescription(productId, tone);
      if ('message' in res) setSyncResult({ ok: true, msg: res.message });
      else setGeneratedDesc(res);
    } catch (err: unknown) { setError(err instanceof Error ? err.message : 'Generation failed'); }
    finally { setGenerating(null); }
  };

  const handleApprove = async (editedText: string) => {
    if (!generatedDesc) return;
    await approveDescription(generatedDesc.id, editedText);
    await load();
  };

  const handleBatchGenerate = async () => {
    setBatchGenerating(true); setError(null);
    try {
      const result = await generateMissingDescriptions(); await load();
      const msg = `Generated ${result.generated}/${result.total} description(s).` + (result.errors?.length ? ` ${result.errors.length} error(s).` : '');
      setSyncResult({ ok: true, msg: result.generated > 0 ? msg : 'All products already have descriptions.' });
    } catch (err: unknown) { setError(err instanceof Error ? err.message : 'Batch generation failed'); }
    finally { setBatchGenerating(false); }
  };

  const totalValue = products.reduce((s, p) => s + p.price * p.inventory, 0);

  return (
    <div className="space-y-6">
      <Card className="border-primary/10">
        <CardContent className="p-6">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <Badge variant="info" className="mb-2"><Package className="h-3 w-3 mr-1" /> Product Catalog</Badge>
              <h1 className="text-2xl font-bold tracking-tight">Products</h1>
              <p className="mt-1 text-sm text-muted-foreground">{products.length} synced · Inventory value: ${totalValue.toFixed(2)}</p>
            </div>
            <div className="flex gap-2">
              <Button variant="secondary" size="sm" onClick={handleBatchGenerate} disabled={batchGenerating}>
                <Sparkles className={cn('h-4 w-4', batchGenerating && 'animate-pulse')} />
                {batchGenerating ? 'Generating...' : 'Generate All Missing'}
              </Button>
              <Button size="sm" onClick={load} disabled={loading}><RefreshCcw className={cn('h-4 w-4', loading && 'animate-spin')} /> Refresh</Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {syncResult && (
        <div className={cn('animate-slide-down rounded-lg border px-4 py-3 text-sm flex items-center gap-2', syncResult.ok ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : 'border-rose-500/20 bg-rose-500/10 text-rose-600 dark:text-rose-400')}>
          <span>{syncResult.msg}</span>
          <button onClick={() => setSyncResult(null)} className="ml-auto"><X className="h-4 w-4" /></button>
        </div>
      )}

      {error && (
        <div className="animate-slide-down flex items-center gap-2 rounded-lg border border-destructive/20 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          <AlertCircle className="h-4 w-4 shrink-0" /> {error}
          <button onClick={() => setError(null)} className="ml-auto"><X className="h-4 w-4" /></button>
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-wrap gap-3">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input type="text" placeholder="Search products..." value={search} onChange={(e) => setSearch(e.target.value)} className="pl-9" />
        </div>

        {/* Tone picker */}
        <div className="relative">
          <Button variant={selectedTone ? 'default' : 'outline'} size="sm" onClick={() => setShowTonePicker((v) => !v)}>
            <Sparkles className="h-3.5 w-3.5" /> Tone: {selectedTone ? TONE_OPTIONS.find((t) => t.value === selectedTone)?.label.replace(/ \(.*\)$/, '') : 'Default'} <ChevronDown className="h-3 w-3" />
          </Button>
          {showTonePicker && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setShowTonePicker(false)} />
              <div className="absolute right-0 top-full z-20 mt-1 w-56 rounded-lg border bg-popover p-1 shadow-lg">
                {TONE_OPTIONS.map((opt) => (
                  <button key={opt.value} onClick={() => { setSelectedTone(opt.value); setShowTonePicker(false); }}
                    className={cn('flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-xs transition-colors', selectedTone === opt.value ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground')}>
                    <span className="flex-1">
                      <span className="block font-medium">{opt.label.replace(/ \(.*\)$/, '')}</span>
                      <span className="block text-[10px] text-muted-foreground/70">{opt.description}</span>
                    </span>
                    {selectedTone === opt.value && <CheckCircle2 className="h-3 w-3 shrink-0 text-primary" />}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>

        <div className="flex rounded-lg border border-border/60 bg-card p-1 gap-0.5">
          {(['all', 'active', 'draft', 'archived'] as FilterStatus[]).map((f) => (
            <button key={f} onClick={() => setFilter(f)}
              className={cn('rounded-md px-3 py-1.5 text-xs font-medium capitalize transition-colors', filter === f ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:text-foreground')}>{f}</button>
          ))}
        </div>
      </div>

      {/* Table */}
      <Card>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Product</TableHead>
                <TableHead>Vendor</TableHead>
                <TableHead className="text-right">Price</TableHead>
                <TableHead className="text-right">Stock</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-center">AI Copy</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                Array.from({ length: 6 }).map((_, i) => (
                  <TableRow key={i}>
                    {Array.from({ length: 6 }).map((_, j) => (<TableCell key={j}><div className="h-4 w-full animate-pulse rounded bg-muted" /></TableCell>))}
                  </TableRow>
                ))
              ) : filtered.length === 0 ? (
                <TableRow><TableCell colSpan={6} className="py-12 text-center text-muted-foreground">
                  <Package className="mx-auto mb-3 h-8 w-8 text-muted-foreground/50" /> No products found.
                </TableCell></TableRow>
              ) : (
                filtered.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell className="max-w-xs">
                      <p className="font-medium truncate">{p.title}</p>
                      <p className="text-xs text-muted-foreground">ID: {p.shopifyProductId}</p>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{p.vendor ?? '—'}</TableCell>
                    <TableCell className="text-right font-mono">${Number(p.price).toFixed(2)}</TableCell>
                    <TableCell className="text-right">
                      <span className={cn('font-mono font-medium', p.inventory <= 5 ? 'text-amber-500' : p.inventory === 0 ? 'text-rose-500' : '')}>{p.inventory}</span>
                    </TableCell>
                    <TableCell>
                      <Badge variant={p.status === 'active' ? 'success' : p.status === 'draft' ? 'warning' : 'secondary'}>{p.status ?? 'unknown'}</Badge>
                    </TableCell>
                    <TableCell className="text-center">
                      <Button variant="outline" size="sm" onClick={() => handleGenerate(p.id)} disabled={generating === p.id}>
                        {generating === p.id ? <RefreshCcw className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
                        Generate
                      </Button>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </Card>

      {generatedDesc && <ReviewModal description={generatedDesc} onApprove={handleApprove} onClose={() => setGeneratedDesc(null)} />}
    </div>
  );
}
