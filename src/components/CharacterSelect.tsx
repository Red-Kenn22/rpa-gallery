import { memo, useRef, useState } from 'react';
import { useAssetThumbnail } from '../hooks/useAssetThumbnail';
import { useInView } from '../hooks/useInView';
import { formatDuration, normalizeHex } from '../lib/format';
import type { CharacterInfo, GalleryIndex } from '../types';
import { ImageIcon } from './Icons';

export const MISC_ID = '__misc__';

function Portrait({ index, files, path, active }: { index: GalleryIndex; files: File[] | null; path?: string; active: boolean }) {
  const src = useAssetThumbnail(index, path, files, active);
  return src ? (
    <img src={src} alt="" className="size-full object-cover object-top" draggable={false} />
  ) : (
    <div className="grid size-full place-items-center bg-gradient-to-b from-neutral-800 to-neutral-900 text-neutral-600">
      <ImageIcon width={28} height={28} />
    </div>
  );
}

const CharacterCard = memo(function CharacterCard({
  index,
  files,
  name,
  color,
  path,
  sub,
  onClick,
  id,
}: {
  index: GalleryIndex;
  files: File[] | null;
  name: string;
  color?: string;
  path?: string;
  sub: string;
  onClick: () => void;
  id: string;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const inView = useInView(ref);
  const accent = normalizeHex(color) ?? '#fda4af';
  return (
    <button
      ref={ref}
      type="button"
      onClick={onClick}
      className="group relative aspect-[3/4] overflow-hidden rounded-2xl bg-neutral-900 text-left ring-1 ring-white/[0.08] transition hover:ring-white/20 focus-visible:ring-2 focus-visible:ring-rose-400 focus-visible:outline-none active:scale-[0.98]"
      data-character={id}
    >
      <Portrait index={index} files={files} path={path} active={inView} />
      <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 via-black/60 to-transparent px-3 pt-10 pb-2.5">
        <p className="truncate text-[17px] leading-tight font-bold" style={{ color: accent, textShadow: `0 0 12px ${accent}66` }}>
          {name}
        </p>
        <p className="mt-0.5 text-[11px] text-neutral-300">{sub}</p>
      </div>
    </button>
  );
});

/** First screen of a game: pick a character (or All scenes / Misc). */
export function CharacterSelect({
  index,
  files,
  characters,
  portraitOf,
  onPick,
}: {
  index: GalleryIndex;
  files: File[] | null;
  characters: CharacterInfo[];
  portraitOf: (c: CharacterInfo) => string | undefined;
  onPick: (id: string | null) => void;
}) {
  const totals = new Map<string, number>();
  for (const s of index.scenes) for (const id of s.characters) totals.set(id, (totals.get(id) ?? 0) + s.durationSec);
  const misc = index.scenes.filter((s) => s.characters.length === 0);
  const allSecs = index.scenes.reduce((n, s) => n + s.durationSec, 0);
  const tile = 'grid aspect-[3/4] place-items-center rounded-2xl p-3 text-center ring-1 transition active:scale-[0.98]';
  const sub = (c: CharacterInfo) => `${c.sceneCount} scene${c.sceneCount === 1 ? '' : 's'} · ${formatDuration(totals.get(c.id) ?? 0)}`;
  // Cards for the main cast; the player character and minor characters go in a compact list.
  const cards = characters.filter((c) => c.role !== 'minor' && c.role !== 'protagonist');
  const others = characters
    .filter((c) => c.role === 'minor' || c.role === 'protagonist')
    .sort((a, b) => (a.role === 'protagonist' ? -1 : b.role === 'protagonist' ? 1 : b.lineCount - a.lineCount));
  const [showOthers, setShowOthers] = useState(false);

  return (
    <section aria-label="Characters" className="pt-3">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5" data-character-grid>
        <button type="button" onClick={() => onPick(null)} className={`${tile} bg-gradient-to-br from-rose-500/25 to-violet-600/25 ring-white/10 hover:ring-white/25`} data-all-scenes>
          <span>
            <span className="block text-lg font-bold">All scenes</span>
            <span className="mt-1 block text-xs text-neutral-300">
              {index.scenes.length} scenes · {formatDuration(allSecs)}
            </span>
          </span>
        </button>
        {cards.map((c) => (
          <CharacterCard
            key={c.id}
            id={c.id}
            index={index}
            files={files}
            name={c.name}
            color={c.color}
            path={portraitOf(c)}
            sub={sub(c)}
            onClick={() => onPick(c.id)}
          />
        ))}
        {misc.length > 0 && (
          <button type="button" onClick={() => onPick(MISC_ID)} className={`${tile} bg-white/[0.04] ring-white/10 hover:ring-white/25`} data-character={MISC_ID}>
            <span>
              <span className="block text-lg font-bold text-emerald-300">Misc</span>
              <span className="mt-1 block text-xs text-neutral-300">
                {misc.length} scene{misc.length === 1 ? '' : 's'} without characters
              </span>
            </span>
          </button>
        )}
      </div>
      {others.length > 0 && (
        <div className="mt-4">
          <button
            type="button"
            onClick={() => setShowOthers((v) => !v)}
            aria-expanded={showOthers}
            className="w-full rounded-xl bg-white/[0.04] px-4 py-3 text-left text-sm font-medium text-neutral-200 ring-1 ring-white/10 active:scale-[0.99]"
            data-more-characters
          >
            {showOthers ? 'Hide' : 'More characters'} <span className="text-neutral-500">· {others.length}</span>
          </button>
          {showOthers && (
            <ul className="mt-2 divide-y divide-white/5 overflow-hidden rounded-xl bg-white/[0.03] ring-1 ring-white/5" data-other-characters>
              {others.map((c) => (
                <li key={c.id}>
                  <button type="button" onClick={() => onPick(c.id)} className="flex w-full items-baseline justify-between gap-3 px-4 py-2.5 text-left active:bg-white/5" data-character={c.id}>
                    <span className="min-w-0 truncate text-sm font-semibold" style={{ color: normalizeHex(c.color) ?? '#e5e5e5' }}>
                      {c.name}
                      {c.role === 'protagonist' && <span className="ml-2 text-[11px] font-normal text-neutral-400">player character</span>}
                    </span>
                    <span className="shrink-0 text-[11px] text-neutral-500">{sub(c)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
