'use client';

import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { LucideIcon } from 'lucide-react';

const accentMap: Record<string, { bg: string; text: string; dot: string }> = {
  emerald: { bg: 'bg-emerald-500/10', text: 'text-emerald-600 dark:text-emerald-400', dot: 'bg-emerald-500' },
  amber: { bg: 'bg-amber-500/10', text: 'text-amber-600 dark:text-amber-400', dot: 'bg-amber-500' },
  rose: { bg: 'bg-rose-500/10', text: 'text-rose-600 dark:text-rose-400', dot: 'bg-rose-500' },
  indigo: { bg: 'bg-indigo-500/10', text: 'text-indigo-600 dark:text-indigo-400', dot: 'bg-indigo-500' },
  violet: { bg: 'bg-violet-500/10', text: 'text-violet-600 dark:text-violet-400', dot: 'bg-violet-500' },
  cyan: { bg: 'bg-cyan-500/10', text: 'text-cyan-600 dark:text-cyan-400', dot: 'bg-cyan-500' },
  blue: { bg: 'bg-blue-500/10', text: 'text-blue-600 dark:text-blue-400', dot: 'bg-blue-500' },
};

interface StatCardProps {
  label: string;
  value: string | number;
  icon: LucideIcon;
  subtext?: string;
  accent?: string;
}

export default function StatCard({ label, value, icon: Icon, subtext, accent = 'indigo' }: StatCardProps) {
  const a = accentMap[accent] ?? accentMap.indigo;
  return (
    <Card className="border-border/50">
      <CardContent className="flex items-center gap-4 p-5">
        <div className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-xl', a.bg)}>
          <Icon className={cn('h-5 w-5', a.text)} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium tracking-wider text-muted-foreground uppercase">{label}</p>
          <p className={cn('mt-0.5 text-xl font-bold tracking-tight', a.text)}>{value}</p>
          {subtext && <p className="mt-0.5 text-[11px] text-muted-foreground/70">{subtext}</p>}
        </div>
      </CardContent>
    </Card>
  );
}
