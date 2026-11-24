import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useMediaUrls } from '../hooks/useMediaUrls';
import { formatDuration, normalizeHex } from '../lib/format';
import { mediaKind } from '../lib/media';
import { PlayerEngine, type Layer } from '../lib/playerEngine';
import type { GalleryIndex, ScenePrograms, SceneInfo } from '../types';
import { ChevronLeftIcon, DownloadIcon, ForkNextIcon, ForkPrevIcon, ListIcon, XIcon } from './Icons';
import { ChoiceDetails } from './player/ChoiceDetails';
import { HistoryPanel } from './player/HistoryPanel';
import { Scrubber } from './player/Scrubber';

const DEFAULT_STAGE = { w: 1920, h: 1080 };
const DEFAULT_POS: [number, number] = [0.5, 1];
/** Fraction of the screen width on the left that means "back". */
const BACK_ZONE = 0.22;

type Size = { w: number; h: number };

function download(url: string, name: string) {
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** One image or looping video placed on the stage like Ren'Py does (align within the stage). */
function StageMedia({
  layer,
  url,
  stage,
  scale,
  size,
  onSize,
}: {
  layer: Layer;
  url: string | undefined;
  stage: Size;
  scale: number;
  size: Size | undefined;
  onSize: (s: Size) => void;
}) {
  if (!url || !layer.img) return null;
  const [xa, ya] = layer.pos ?? DEFAULT_POS;
  const style: CSSProperties = size
    ? {
        position: 'absolute',
        width: size.w * scale,
        height: size.h * scale,
        left: (stage.w - size.w) * xa * scale,
        top: (stage.h - size.h) * ya * scale,
        maxWidth: 'none',
      }
    : { position: 'absolute', opacity: 0 };
  if (mediaKind(layer.img) === 'video') {
    return (
      <video
        key={url}
        src={url}
        style={style}
        autoPlay
        loop
        playsInline
        muted
        onLoadedMetadata={(e) => onSize({ w: e.currentTarget.videoWidth, h: e.currentTarget.videoHeight })}
      />
    );
  }
  return (
    <img
      key={url}
      src={url}
      alt=""
      draggable={false}
      style={style}
      onLoad={(e) => onSize({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
    />
  );
}

export function ScenePlayer({
  scene,
  index,
  programs,
  files,
  sceneForLabel,
  onClose,
  onContinue,
}: {
  scene: SceneInfo;
  index: GalleryIndex;
  programs: ScenePrograms;
  files: File[];
  sceneForLabel: (label: string) => SceneInfo | undefined;
  onClose: () => void;
  onContinue: (scene: SceneInfo) => void;
}) {
  const [autoBranch, setAutoBranch] = useState(() => {
    try {
      return localStorage.getItem('rpa.autoBranch') === '1';
    } catch {
      return false;
    }
  });
  const engineRef = useRef<PlayerEngine | null>(null);
  if (!engineRef.current) engineRef.current = new PlayerEngine(programs, scene.labels, { autoBranch });
  const engine = engineRef.current;
  const [, setTick] = useState(0);
  const refresh = () => setTick((t) => t + 1);
  const [choicesVersion, setChoicesVersion] = useState(0);
  const [showLog, setShowLog] = useState(false);
  const [backHint, setBackHint] = useState(() => {
    try {
      return localStorage.getItem('rpa.backHint') !== 'seen';
    } catch {
      return false;
    }
  });
  // The scrubber's path: your choices where made, else the first option. Recomputed when you choose.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const timeline = useMemo(() => engine.timeline(), [engine, choicesVersion, autoBranch]);
  const position = Math.min(engine.position, timeline.stops.length - 1);
  const sceneById = useMemo(() => {
    const m = new Map(index.scenes.map((sc) => [sc.id, sc]));
    return (id: string) => m.get(id);
  }, [index]);
  const titleForLabel = (label: string) => sceneForLabel(label)?.title;
  const swipe = useRef<{ x: number; y: number; swiped: boolean } | null>(null);

  const media = useMediaUrls(index, files);
  const root = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<Size>({ w: window.innerWidth, h: window.innerHeight });
  const [sizes, setSizes] = useState<Record<string, Size>>({});
  const v = engine.view;

  // Stage = game resolution; fall back to the first background's size.
  const firstBgSize = v.bg?.img ? sizes[v.bg.img] : undefined;
  const stage = programs.stage ?? firstBgSize ?? DEFAULT_STAGE;
  const scale = Math.min(box.w / stage.w, box.h / stage.h);

  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setBox({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Full screen + landscape where the browser allows it (Android Chrome; iOS ignores this).
  useEffect(() => {
    const el = root.current;
    let entered = false;
    if (el && document.fullscreenEnabled && !document.fullscreenElement) {
      el.requestFullscreen?.({ navigationUI: 'hide' })
        .then(() => {
          entered = true;
          return (screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> }).lock?.('landscape');
        })
        .catch(() => {});
    }
    return () => {
      if (entered && document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    };
  }, []);

  // Preload what the next taps will show; never evict what's on screen.
  const onScreen = [v.bg?.img, ...v.layers.map((l) => l.img), v.video?.img];
  media.setVisible(onScreen);
  useEffect(() => {
    media.preload(engine.upcoming(3));
  });

  const advance = useCallback(() => {
    engine.advance();
    refresh();
  }, [engine]);
  const back = useCallback(() => {
    engine.back();
    refresh();
  }, [engine]);
  const choose = (i: number) => {
    engine.choose(i);
    setChoicesVersion((n) => n + 1);
    refresh();
  };
  const jump = (i: number) => {
    engine.jumpTo(i, timeline);
    refresh();
  };
  const prevFork = [...timeline.forks].reverse().find((f) => f.i < position);
  const nextFork = timeline.forks.find((f) => f.i > position);

  useEffect(() => {
    if (!backHint) return;
    const t = setTimeout(() => setBackHint(false), 3500);
    try {
      localStorage.setItem('rpa.backHint', 'seen');
    } catch {
      /* storage unavailable */
    }
    return () => clearTimeout(t);
  }, [backHint]);

  /** Tap: left edge = back, anywhere else = next. Swipe right = back. */
  const onTap = (e: React.MouseEvent) => {
    if (swipe.current?.swiped) {
      swipe.current = null;
      return;
    }
    if (e.clientX < box.w * BACK_ZONE) back();
    else advance();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === ' ' || e.key === 'Enter' || e.key === 'ArrowRight') {
        e.preventDefault();
        advance();
      } else if (e.key === 'ArrowLeft' || e.key === 'Backspace') back();
      else if (e.key === 'Escape' && !document.fullscreenElement) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [advance, back, onClose]);

  const toggleAutoBranch = () => {
    const next = !autoBranch;
    setAutoBranch(next);
    engine.options.autoBranch = next;
    try {
      localStorage.setItem('rpa.autoBranch', next ? '1' : '0');
    } catch {
      /* storage unavailable */
    }
  };

  const speaker = v.say?.who ? programs.speakers[v.say.who] : undefined;
  const next = v.ended?.nextLabel ? sceneForLabel(v.ended.nextLabel) : undefined;
  const frameImg = v.video?.img ?? [...v.layers].reverse().find((l) => l.img)?.img ?? v.bg?.img;
  const frameUrl = media.url(frameImg);
  const missingBg = v.bg && (!v.bg.img || media.failed(v.bg.img)) ? v.bg.name : null;
  const setSize = useMemo(() => (path: string) => (s: Size) => setSizes((m) => (m[path] ? m : { ...m, [path]: s })), []);
  const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();

  return (
    <div
      ref={root}
      className="fixed inset-0 z-[60] overflow-hidden bg-black select-none"
      onClick={onTap}
      onPointerDown={(e) => (swipe.current = { x: e.clientX, y: e.clientY, swiped: false })}
      onPointerUp={(e) => {
        const s0 = swipe.current;
        if (!s0) return;
        const dx = e.clientX - s0.x;
        const dy = e.clientY - s0.y;
        if (dx > 70 && Math.abs(dy) < 60 && e.pointerType !== 'mouse') {
          s0.swiped = true;
          back();
        }
      }}
      role="application"
      aria-label={`Playing ${scene.title}`}
      data-player
    >
      {/* Stage */}
      <div
        className="absolute overflow-hidden"
        style={{ width: stage.w * scale, height: stage.h * scale, left: (box.w - stage.w * scale) / 2, top: (box.h - stage.h * scale) / 2 }}
      >
        {v.bg && (
          <StageMedia layer={{ ...v.bg, pos: v.bg.pos ?? DEFAULT_POS }} url={media.url(v.bg.img)} stage={stage} scale={scale} size={v.bg.img ? sizes[v.bg.img] : undefined} onSize={setSize(v.bg.img ?? '')} />
        )}
        {v.layers.map((l) => (
          <StageMedia key={l.tag} layer={l} url={media.url(l.img)} stage={stage} scale={scale} size={l.img ? sizes[l.img] : undefined} onSize={setSize(l.img ?? '')} />
        ))}
        {missingBg && (
          <div className="absolute inset-0 grid place-items-center text-sm text-neutral-500">
            <span className="rounded bg-white/5 px-2 py-1">image not found: {missingBg}</span>
          </div>
        )}
      </div>

      {/* Cutscene */}
      {v.video && (
        <div className="absolute inset-0 grid place-items-center bg-black">
          {media.url(v.video.img) ? (
            <video key={media.url(v.video.img)} src={media.url(v.video.img)} autoPlay playsInline className="size-full object-contain" onEnded={advance} onError={advance} />
          ) : (
            <span className="text-sm text-neutral-500">{media.failed(v.video.img) || !v.video.img ? `video not found: ${v.video.name}` : 'Loading…'}</span>
          )}
        </div>
      )}

      {/* Top bar */}
      <div className="absolute inset-x-0 top-0 z-30 bg-gradient-to-b from-black/75 to-transparent px-3 pt-[max(0.5rem,env(safe-area-inset-top))] pb-5" onClick={stop} onPointerDown={stop} onPointerUp={stop}>
        <div className="flex items-center gap-2">
          <button type="button" onClick={onClose} className="grid size-9 place-items-center rounded-full bg-black/40" aria-label="Close player">
            <XIcon width={18} height={18} />
          </button>
          <p className="min-w-0 flex-1 truncate text-xs font-semibold text-white/90">{scene.title}</p>
          <button type="button" onClick={toggleAutoBranch} className="rounded-full bg-black/40 px-2.5 py-1.5 text-[11px] font-medium text-white/80" aria-label="Branch mode">
            {autoBranch ? 'Ifs: auto' : 'Ifs: ask'}
          </button>
          {frameUrl && frameImg && (
            <button type="button" onClick={() => download(frameUrl, frameImg.slice(frameImg.lastIndexOf('/') + 1))} className="grid size-9 place-items-center rounded-full bg-black/40" aria-label="Save this image">
              <DownloadIcon width={17} height={17} />
            </button>
          )}
          <button type="button" onClick={() => setShowLog(true)} className="grid size-9 place-items-center rounded-full bg-black/40" aria-label="Scene log">
            <ListIcon width={17} height={17} />
          </button>
          <button type="button" onClick={back} disabled={!engine.canGoBack} className="grid size-9 place-items-center rounded-full bg-black/40 disabled:opacity-30" aria-label="Back one line">
            <ChevronLeftIcon width={18} height={18} />
          </button>
        </div>
        <div className="mt-1 flex items-center gap-1.5">
          <button type="button" onClick={() => prevFork && jump(prevFork.i)} disabled={!prevFork} className="grid size-8 place-items-center rounded-full text-amber-200 disabled:opacity-25" aria-label="Previous choice">
            <ForkPrevIcon width={16} height={16} />
          </button>
          <Scrubber timeline={timeline} position={position} programs={programs} onCommit={jump} />
          <button type="button" onClick={() => nextFork && jump(nextFork.i)} disabled={!nextFork} className="grid size-8 place-items-center rounded-full text-amber-200 disabled:opacity-25" aria-label="Next choice">
            <ForkNextIcon width={16} height={16} />
          </button>
        </div>
      </div>

      {backHint && (
        <div className="pointer-events-none absolute inset-y-0 left-0 flex w-[22%] items-center justify-center bg-gradient-to-r from-white/15 to-transparent" data-back-hint>
          <span className="rounded-full bg-black/60 px-3 py-1.5 text-center text-[11px] text-white">‹ Tap here to go back</span>
        </div>
      )}

      {/* Text box */}
      {v.say && (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 via-black/70 to-transparent px-5 pt-10 pb-[max(1rem,env(safe-area-inset-bottom))]">
          <div className="mx-auto max-w-3xl">
            {speaker && (
              <p className="mb-1 text-sm font-bold" style={{ color: normalizeHex(speaker.color) ?? '#fda4af' }} data-speaker>
                {speaker.name}
              </p>
            )}
            <p className={`text-[17px] leading-relaxed ${v.say.who ? 'text-white' : 'text-white/80 italic'}`} data-say>
              {v.say.what}
            </p>
          </div>
        </div>
      )}

      {/* Menu: the question, then each choice with what it leads to */}
      {v.menu && (
        <div className="absolute inset-0 overflow-y-auto bg-black/55 px-5 pt-24 pb-8" onClick={stop} onPointerDown={stop} onPointerUp={stop}>
          <div className="mx-auto flex max-w-lg flex-col gap-2.5">
            {engine.previousLine && (
              <div className="rounded-xl bg-black/60 px-4 py-2.5 text-[14px] leading-relaxed ring-1 ring-white/10" data-question>
                {engine.previousLine.who && (
                  <span className="mr-1.5 font-bold" style={{ color: normalizeHex(programs.speakers[engine.previousLine.who]?.color) ?? '#fda4af' }}>
                    {programs.speakers[engine.previousLine.who]?.name ?? engine.previousLine.who}
                  </span>
                )}
                <span className={engine.previousLine.who ? 'text-white' : 'text-white/80 italic'}>{engine.previousLine.what}</span>
              </div>
            )}
            {v.menu.map((c, i) => (
              <button key={i} type="button" onClick={() => choose(i)} className="w-full rounded-xl bg-neutral-900/90 px-4 py-3 text-left text-[15px] font-medium text-white ring-1 ring-white/15 active:scale-[0.98]" data-choice>
                {c.text}
                {c.cond && <span className="mt-0.5 block font-mono text-[11px] text-neutral-400">requires {c.cond}</span>}
                {c.info && <ChoiceDetails info={c.info} programs={programs} scene={scene} sceneById={sceneById} titleForLabel={titleForLabel} />}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* If-branch picker */}
      {v.branch && (
        <div className="absolute inset-0 flex flex-col items-center overflow-y-auto bg-black/65 px-5 pt-24 pb-8" onClick={stop} onPointerDown={stop} onPointerUp={stop}>
          <p className="mb-2.5 text-center text-xs text-neutral-300">The game checks its state here. Which way should it go?</p>
          {v.branch.map((b, i) => (
            <button key={i} type="button" onClick={() => choose(i)} className="mb-2.5 w-full max-w-lg rounded-xl bg-neutral-900/90 px-4 py-2.5 text-left ring-1 ring-sky-400/20 active:scale-[0.98]" data-branch>
              <span className="block font-mono text-[13px] text-sky-200">{b.cond === 'True' ? 'otherwise' : b.cond}</span>
              {b.info && <ChoiceDetails info={b.info} programs={programs} scene={scene} sceneById={sceneById} titleForLabel={titleForLabel} />}
            </button>
          ))}
          <button type="button" onClick={() => { toggleAutoBranch(); choose(0); }} className="mt-1 text-xs text-neutral-400 underline underline-offset-2">
            Always take the first option
          </button>
        </div>
      )}

      {showLog && (
        <HistoryPanel
          timeline={timeline}
          position={position}
          programs={programs}
          onJump={(i) => {
            jump(i);
            setShowLog(false);
          }}
          onClose={() => setShowLog(false)}
        />
      )}

      {/* End */}
      {v.ended && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/75 px-6 text-center" onClick={stop} onPointerDown={stop} onPointerUp={stop} data-ended>
          <p className="text-lg font-semibold">{v.ended.reason === 'missing' ? 'Part of this scene is missing' : 'End of scene'}</p>
          {v.ended.reason === 'missing' && <p className="text-xs text-neutral-400">The script refers to a label that isn't in these files: {v.ended.nextLabel}</p>}
          {next && (
            <button type="button" onClick={() => onContinue(next)} className="w-full max-w-xs rounded-full bg-white px-4 py-2.5 text-sm font-semibold text-neutral-950">
              Continue: {next.title} <span className="font-normal text-neutral-500">· {formatDuration(next.durationSec)}</span>
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              engineRef.current = new PlayerEngine(programs, scene.labels, { autoBranch });
              refresh();
            }}
            className="w-full max-w-xs rounded-full px-4 py-2.5 text-sm text-white ring-1 ring-white/25"
          >
            Replay
          </button>
          <button type="button" onClick={onClose} className="text-sm text-neutral-400">
            Close
          </button>
        </div>
      )}
    </div>
  );
}
