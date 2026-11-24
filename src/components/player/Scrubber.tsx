import { useRef, useState } from 'react';
import type { State, Timeline } from '../../lib/playerEngine';
import type { ScenePrograms } from '../../types';

function stopLabel(s: State, programs: ScenePrograms): string {
  const v = s.view;
  if (v.ended) return 'End of scene';
  if (v.menu) return `Choice: ${v.menu.map((c) => c.text).join(' / ')}`;
  if (v.branch) return 'The game checks its state';
  if (v.video) return `Video: ${v.video.name}`;
  if (v.say) return `${v.say.who ? `${programs.speakers[v.say.who]?.name ?? v.say.who}: ` : ''}${v.say.what}`;
  return v.bg?.name ? `Image: ${v.bg.name}` : 'Image';
}

/**
 * Draggable scene timeline. Fork dots: filled = your choice, hollow = assumed
 * (previous choice, else the first). Past the first assumed fork the track is
 * striped. The preview shows the line you'll land on; release to jump.
 */
export function Scrubber({
  timeline,
  position,
  programs,
  onCommit,
}: {
  timeline: Timeline;
  position: number;
  programs: ScenePrograms;
  onCommit: (i: number) => void;
}) {
  const track = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const n = timeline.stops.length;
  const pct = (i: number) => (n > 1 ? (i / (n - 1)) * 100 : 0);
  const indexAt = (clientX: number) => {
    const r = track.current!.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    return Math.round(f * (n - 1));
  };
  const shown = drag ?? position;
  const firstAssumed = timeline.forks.find((f) => !f.chosen && f.i >= position)?.i;

  return (
    <div className="relative min-w-0 flex-1">
      <div
        ref={track}
        className="relative h-7 cursor-pointer touch-none"
        role="slider"
        aria-label="Scene position"
        aria-valuemin={0}
        aria-valuemax={n - 1}
        aria-valuenow={shown}
        data-scrubber
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          setDrag(indexAt(e.clientX));
        }}
        onPointerMove={(e) => drag !== null && setDrag(indexAt(e.clientX))}
        onPointerUp={(e) => {
          if (drag === null) return;
          const i = indexAt(e.clientX);
          setDrag(null);
          if (i !== position) onCommit(i);
        }}
        onPointerCancel={() => setDrag(null)}
      >
        <div className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded bg-white/15" />
        {firstAssumed !== undefined && (
          <div
            className="absolute top-1/2 right-0 h-1 -translate-y-1/2 rounded bg-[repeating-linear-gradient(90deg,rgba(255,255,255,.35)_0_4px,transparent_4px_8px)]"
            style={{ left: `${pct(firstAssumed)}%` }}
          />
        )}
        <div className="absolute top-1/2 left-0 h-1 -translate-y-1/2 rounded bg-rose-400" style={{ width: `${pct(shown)}%` }} />
        {timeline.forks.map((f) => (
          <span
            key={f.i}
            className={`absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 ${f.chosen ? 'border-amber-300 bg-amber-300' : 'border-amber-300 bg-black'}`}
            style={{ left: `${pct(f.i)}%` }}
            data-fork={f.chosen ? 'chosen' : 'assumed'}
          />
        ))}
        <span className="absolute top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow" style={{ left: `${pct(shown)}%` }} />
      </div>
      {drag !== null && (
        <div className="pointer-events-none absolute top-8 left-1/2 z-10 w-[min(28rem,80vw)] -translate-x-1/2 rounded-lg bg-neutral-900/95 px-3 py-2 text-xs text-neutral-100 ring-1 ring-white/15" data-scrub-preview>
          <span className="text-neutral-400">
            {drag + 1}/{n} ·{' '}
          </span>
          <span className="line-clamp-2">{stopLabel(timeline.stops[drag], programs)}</span>
        </div>
      )}
    </div>
  );
}

export { stopLabel };
