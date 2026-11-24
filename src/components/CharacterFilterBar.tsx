import { useRef } from 'react';
import { normalizeHex } from '../lib/format';
import { ChevronLeftIcon, ChevronRightIcon } from './Icons';
import type { CharacterInfo } from '../types';

export type SortMode = 'story' | 'longest' | 'shortest';

export function SortBar({ value, onChange, count }: { value: SortMode; onChange: (v: SortMode) => void; count: number }) {
  const opts: [SortMode, string][] = [
    ['story', 'Story order'],
    ['longest', 'Longest'],
    ['shortest', 'Shortest'],
  ];
  return (
    <div className="mb-3 flex items-center justify-between gap-3">
      <span className="text-xs text-neutral-500">{count.toLocaleString()} shown</span>
      <div role="radiogroup" aria-label="Sort scenes" className="flex rounded-full bg-white/[0.07] p-0.5 ring-1 ring-white/5">
        {opts.map(([v, label]) => (
          <button
            key={v}
            type="button"
            role="radio"
            aria-checked={value === v}
            onClick={() => onChange(v)}
            className={`rounded-full px-3 py-1 text-xs font-medium transition ${value === v ? 'bg-white text-neutral-950' : 'text-neutral-300'}`}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}

export function CharacterFilterBar({
  characters,
  selected,
  onSelect,
  total,
}: {
  characters: CharacterInfo[];
  selected: string | null;
  onSelect: (id: string | null) => void;
  total: number;
}) {
  const pill = 'flex shrink-0 snap-start items-center gap-1.5 rounded-full px-3.5 py-1.5 text-sm font-medium whitespace-nowrap transition active:scale-95';
  const on = 'bg-white text-neutral-950';
  const off = 'bg-white/[0.07] text-neutral-200 ring-1 ring-white/5';
  const nav = useRef<HTMLElement>(null);
  const scrollBy = (dx: number) => nav.current?.scrollBy({ left: dx, behavior: 'smooth' });
  return (
    <div className="relative -mx-4">
      <nav
        ref={nav}
        aria-label="Filter by character"
        className="no-scrollbar flex snap-x gap-2 overflow-x-auto px-4 py-3 [mask-image:linear-gradient(to_right,black_calc(100%-2.5rem),transparent)] sm:px-10"
      >
        <button type="button" aria-pressed={selected === null} className={`${pill} ${selected === null ? on : off}`} onClick={() => onSelect(null)}>
          All <span className="text-xs opacity-60">{total}</span>
        </button>
        {characters.map((c) => (
          <button
            key={c.id}
            type="button"
            aria-pressed={selected === c.id}
            className={`${pill} ${selected === c.id ? on : off}`}
            onClick={() => onSelect(selected === c.id ? null : c.id)}
          >
            <span className="size-2 rounded-full ring-1 ring-black/15" style={{ background: normalizeHex(c.color) ?? '#a3a3a3' }} />
            {c.name}
            <span className="text-xs opacity-60">{c.sceneCount}</span>
          </button>
        ))}
      </nav>
      {/* Desktop: scroll buttons (touch screens just swipe) */}
      <button type="button" onClick={() => scrollBy(-240)} className="absolute top-1/2 left-1 hidden size-7 -translate-y-1/2 place-items-center rounded-full bg-neutral-800 text-neutral-300 ring-1 ring-white/10 hover:text-white sm:grid" aria-label="Scroll characters left">
        <ChevronLeftIcon width={15} height={15} />
      </button>
      <button type="button" onClick={() => scrollBy(240)} className="absolute top-1/2 right-1 hidden size-7 -translate-y-1/2 place-items-center rounded-full bg-neutral-800 text-neutral-300 ring-1 ring-white/10 hover:text-white sm:grid" aria-label="Scroll characters right">
        <ChevronRightIcon width={15} height={15} />
      </button>
    </div>
  );
}
