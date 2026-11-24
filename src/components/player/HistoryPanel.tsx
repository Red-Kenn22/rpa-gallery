import { useEffect, useRef } from 'react';
import { normalizeHex } from '../../lib/format';
import type { Timeline } from '../../lib/playerEngine';
import type { ScenePrograms } from '../../types';
import { XIcon } from '../Icons';

/** The whole scene as text (past solid, ahead dimmed); tap any line to jump there. */
export function HistoryPanel({
  timeline,
  position,
  programs,
  onJump,
  onClose,
}: {
  timeline: Timeline;
  position: number;
  programs: ScenePrograms;
  onJump: (i: number) => void;
  onClose: () => void;
}) {
  const current = useRef<HTMLLIElement>(null);
  useEffect(() => {
    // Block body on purpose: newer Chrome returns a Promise from scrollIntoView,
    // and React would treat a returned value as a cleanup function.
    current.current?.scrollIntoView({ block: 'center' });
  }, []);
  const forkAt = new Map(timeline.forks.map((f) => [f.i, f]));

  // Nothing inside the log (taps, swipes) may reach the player underneath.
  const isolate = {
    onClick: (e: React.SyntheticEvent) => e.stopPropagation(),
    onPointerDown: (e: React.SyntheticEvent) => e.stopPropagation(),
    onPointerUp: (e: React.SyntheticEvent) => e.stopPropagation(),
  };
  return (
    <>
    <div
      className="absolute inset-0 z-40 bg-black/40"
      {...isolate}
      onClick={(e) => {
        e.stopPropagation();
        onClose();
      }}
      aria-hidden="true"
      data-history-backdrop
    />
    <div className="absolute inset-y-0 right-0 z-40 flex w-[min(26rem,92vw)] flex-col bg-neutral-950/95 pr-[env(safe-area-inset-right)] ring-1 ring-white/10 backdrop-blur" {...isolate} data-history>
      <div className="flex items-center justify-between px-4 pt-[max(0.75rem,env(safe-area-inset-top))] pb-2">
        <p className="text-sm font-semibold">Scene log</p>
        <button type="button" onClick={onClose} className="grid size-8 place-items-center rounded-full bg-white/10" aria-label="Close log">
          <XIcon width={16} height={16} />
        </button>
      </div>
      <ol className="min-h-0 flex-1 space-y-1 overflow-y-auto overscroll-contain px-2 pb-6">
        {timeline.stops.map((s, i) => {
          const v = s.view;
          const fork = forkAt.get(i);
          const ahead = i > position;
          const isCurrent = i === position;
          const who = v.say?.who ? programs.speakers[v.say.who] : undefined;
          let body: React.ReactNode;
          if (v.ended) body = <span className="text-neutral-400">End of scene</span>;
          else if (v.menu) body = <span className="text-amber-200">◆ {v.menu.map((c) => c.text).join(' / ')}</span>;
          else if (v.branch) body = <span className="text-sky-200">◆ The game checks its state</span>;
          else if (v.video) body = <span className="text-neutral-400">▶ {v.video.name}</span>;
          else if (v.say)
            body = (
              <>
                {who && <span className="mr-1.5 font-semibold" style={{ color: normalizeHex(who.color) ?? '#fda4af' }}>{who.name}</span>}
                <span className={v.say.who ? '' : 'text-neutral-400 italic'}>{v.say.what}</span>
              </>
            );
          else body = <span className="text-neutral-500">▣ {v.bg?.name ?? 'image'}</span>;
          return (
            <li key={i} ref={isCurrent ? current : undefined}>
              <button
                type="button"
                onClick={() => onJump(i)}
                className={`w-full rounded-lg px-3 py-1.5 text-left text-[13px] leading-snug ${isCurrent ? 'bg-rose-500/20 ring-1 ring-rose-400/40' : 'hover:bg-white/5'} ${ahead ? 'opacity-45' : ''}`}
                data-log-line={i}
              >
                {body}
                {fork && !fork.chosen && <span className="ml-1.5 text-[10px] text-neutral-500">(assumed)</span>}
              </button>
            </li>
          );
        })}
        {timeline.truncated && <li className="px-3 py-2 text-xs text-neutral-500">… scene continues (log limited)</li>}
      </ol>
    </div>
    </>
  );
}
