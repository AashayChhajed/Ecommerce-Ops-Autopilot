'use client';

import { useState } from 'react';
import { cn } from '@/lib/utils';

const GRADIENTS = [
  'from-indigo-500 to-violet-500',
  'from-sky-500 to-cyan-400',
  'from-emerald-500 to-teal-400',
  'from-amber-500 to-orange-400',
  'from-rose-500 to-pink-400',
  'from-violet-500 to-fuchsia-400',
];

/** Deterministic gradient per title so the same product always gets the same avatar color */
function gradientFor(title: string): string {
  let hash = 0;
  for (let i = 0; i < title.length; i += 1) hash = (hash * 31 + title.charCodeAt(i)) >>> 0;
  return GRADIENTS[hash % GRADIENTS.length];
}

function initialsFor(title: string): string {
  return title
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? '')
    .join('');
}

export default function ProductThumb({
  src,
  title,
  className,
}: {
  src?: string | null;
  title: string;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const base = cn('h-9 w-9 shrink-0 rounded-md', className);

  if (!src || failed) {
    return (
      <div
        aria-hidden="true"
        className={cn(
          base,
          'flex items-center justify-center bg-gradient-to-br text-[11px] font-bold text-white',
          gradientFor(title),
        )}
      >
        {initialsFor(title) || '?'}
      </div>
    );
  }

  return (
    <img
      src={src}
      alt=""
      role="presentation"
      loading="lazy"
      onError={() => setFailed(true)}
      className={cn(base, 'border border-border/60 object-cover')}
    />
  );
}
