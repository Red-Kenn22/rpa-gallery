import { normalizeHex } from '../lib/format';
import type { CharacterInfo } from '../types';

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
  return (
    <nav aria-label="Filter by character" className="no-scrollbar -mx-4 flex snap-x gap-2 overflow-x-auto px-4 py-3">
      <button type="button" className={`${pill} ${selected === null ? on : off}`} onClick={() => onSelect(null)}>
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
          <span className="size-2 rounded-full" style={{ background: normalizeHex(c.color) ?? '#a3a3a3' }} />
          {c.name}
          <span className="text-xs opacity-60">{c.sceneCount}</span>
        </button>
      ))}
    </nav>
  );
}
