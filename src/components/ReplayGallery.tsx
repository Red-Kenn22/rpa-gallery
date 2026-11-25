import { memo, useMemo, useRef, useState } from 'react';
import { useAssetThumbnail } from '../hooks/useAssetThumbnail';
import { useInView } from '../hooks/useInView';
import type { GalleryIndex, ReplayGallery as Gallery, ReplayInfo } from '../types';
import { ChevronLeftIcon, ImageIcon, PlayIcon } from './Icons';

/** One replay: the game's gallery thumbnail (16:9) and title. */
export const ReplayCard = memo(function ReplayCard({
  index,
  files,
  replay,
  groupNames,
  onPlay,
  compact = false,
}: {
  index: GalleryIndex;
  files: File[] | null;
  replay: ReplayInfo;
  groupNames: Map<string, string>;
  onPlay: (r: ReplayInfo) => void;
  compact?: boolean;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const inView = useInView(ref);
  const src = useAssetThumbnail(index, replay.thumb ?? undefined, files, inView);
  const who = replay.groups.map((g) => groupNames.get(g) ?? g).join(' · ');
  return (
    <button
      ref={ref}
      type="button"
      onClick={() => onPlay(replay)}
      className={`group overflow-hidden rounded-xl bg-neutral-900 text-left ring-1 ring-white/[0.08] transition hover:ring-white/20 focus-visible:ring-2 focus-visible:ring-rose-400 focus-visible:outline-none active:scale-[0.98] ${compact ? 'w-56 shrink-0 snap-start' : ''}`}
      data-replay={replay.label}
    >
      <div className="relative aspect-video bg-neutral-800">
        {src ? (
          <img src={src} alt="" className="size-full object-cover" draggable={false} />
        ) : (
          <div className="grid size-full place-items-center text-neutral-600">
            <ImageIcon width={22} height={22} />
          </div>
        )}
        <span className="absolute right-2 bottom-2 grid size-8 place-items-center rounded-full bg-black/60 text-white ring-1 ring-white/20 backdrop-blur-sm">
          <PlayIcon width={14} height={14} />
        </span>
      </div>
      <div className="px-3 py-2">
        <p className="truncate text-sm font-semibold">{replay.title}</p>
        {who && <p className="truncate text-[11px] text-neutral-400">{who}</p>}
      </div>
    </button>
  );
});

/** The game's own replay gallery: filter by its groups (girls), tap to play. */
export function ReplayGalleryView({
  index,
  files,
  gallery,
  onBack,
  onPlay,
}: {
  index: GalleryIndex;
  files: File[] | null;
  gallery: Gallery;
  onBack: () => void;
  onPlay: (r: ReplayInfo) => void;
}) {
  const [group, setGroup] = useState<string | null>(null);
  const groupNames = useMemo(() => new Map(gallery.groups.map((g) => [g.key, g.name])), [gallery]);
  const shown = group ? gallery.replays.filter((r) => r.groups.includes(group)) : gallery.replays;
  const pill = 'flex shrink-0 snap-start items-center gap-1.5 rounded-full px-3.5 py-1.5 text-sm font-medium whitespace-nowrap transition active:scale-95';
  return (
    <section aria-label="Gallery" className="pt-3" data-gallery>
      <div className="mb-1 flex items-center gap-3">
        <button type="button" onClick={onBack} className="flex items-center gap-1 rounded-full py-1.5 pr-3 pl-1.5 text-sm text-neutral-300 ring-1 ring-white/10 active:scale-95" aria-label="Back to characters">
          <ChevronLeftIcon width={16} height={16} /> Characters
        </button>
      </div>
      <h2 className="mt-3 text-2xl font-bold">Gallery</h2>
      <p className="text-xs text-neutral-400">
        {gallery.replays.length} replay{gallery.replays.length === 1 ? '' : 's'} from the game's own gallery
      </p>
      {gallery.groups.length > 1 && (
        <nav aria-label="Filter gallery" className="no-scrollbar -mx-4 flex snap-x gap-2 overflow-x-auto px-4 py-3">
          <button type="button" aria-pressed={group === null} onClick={() => setGroup(null)} className={`${pill} ${group === null ? 'bg-white text-neutral-950' : 'bg-white/[0.07] text-neutral-200 ring-1 ring-white/5'}`}>
            All <span className="text-xs opacity-60">{gallery.replays.length}</span>
          </button>
          {gallery.groups.map((g) => {
            const n = gallery.replays.filter((r) => r.groups.includes(g.key)).length;
            return (
              <button
                key={g.key}
                type="button"
                aria-pressed={group === g.key}
                onClick={() => setGroup(group === g.key ? null : g.key)}
                className={`${pill} ${group === g.key ? 'bg-white text-neutral-950' : 'bg-white/[0.07] text-neutral-200 ring-1 ring-white/5'}`}
                data-gallery-group={g.key}
              >
                {g.name} <span className="text-xs opacity-60">{n}</span>
              </button>
            );
          })}
        </nav>
      )}
      <div className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 lg:grid-cols-3">
        {shown.map((r) => (
          <ReplayCard key={r.label} index={index} files={files} replay={r} groupNames={groupNames} onPlay={onPlay} />
        ))}
      </div>
    </section>
  );
}

/** A character's replays, shown at the top of their page. */
export function ReplayStrip({
  index,
  files,
  gallery,
  charId,
  onPlay,
}: {
  index: GalleryIndex;
  files: File[] | null;
  gallery: Gallery;
  charId: string;
  onPlay: (r: ReplayInfo) => void;
}) {
  const groupNames = useMemo(() => new Map(gallery.groups.map((g) => [g.key, g.name])), [gallery]);
  const mine = gallery.replays.filter((r) => r.chars.includes(charId));
  if (!mine.length) return null;
  return (
    <section aria-label="Gallery replays" className="mt-2 mb-1" data-replay-strip>
      <h3 className="mb-2 text-xs font-semibold tracking-wider text-neutral-500 uppercase">
        Gallery <span className="font-normal normal-case">· {mine.length}</span>
      </h3>
      <div className="no-scrollbar -mx-4 flex snap-x gap-3 overflow-x-auto px-4 pb-1">
        {mine.map((r) => (
          <ReplayCard key={r.label} index={index} files={files} replay={r} groupNames={groupNames} onPlay={onPlay} compact />
        ))}
      </div>
    </section>
  );
}
