import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useMediaUrls } from '../hooks/useMediaUrls';
import { usePlayerAudio } from '../hooks/usePlayerAudio';
import { formatDuration, normalizeHex } from '../lib/format';
import { mediaKind } from '../lib/media';
import { PlayerEngine, type Layer } from '../lib/playerEngine';
import type { GalleryIndex, ScenePrograms, SceneInfo } from '../types';
import { ChevronLeftIcon, DownloadIcon, EyeOffIcon, ForkNextIcon, ForkPrevIcon, ImageIcon, ListIcon, MoreIcon, SoundOffIcon, SoundOnIcon, XIcon } from './Icons';
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

function placement(size: Size | undefined, pos: [number, number] | null, stage: Size, scale: number): CSSProperties {
  if (!size) return { position: 'absolute', opacity: 0 };
  const [xa, ya] = pos ?? DEFAULT_POS;
  return {
    position: 'absolute',
    width: size.w * scale,
    height: size.h * scale,
    left: (stage.w - size.w) * xa * scale,
    top: (stage.h - size.h) * ya * scale,
    maxWidth: 'none',
  };
}

/**
 * One image or looping video placed on the stage like Ren'Py does (align
 * within the stage). Images keep the previous picture visible until the next
 * one has loaded, so changing images never blinks to black.
 */
function StageMedia({
  layer,
  url,
  stage,
  scale,
  sizeOf,
  onSize,
  muted = true,
}: {
  muted?: boolean;
  layer: Layer;
  url: string | undefined;
  stage: Size;
  scale: number;
  sizeOf: (path: string) => Size | undefined;
  onSize: (path: string, s: Size) => void;
}) {
  const [shown, setShown] = useState<{ url: string; path: string; pos: [number, number] | null } | null>(null);
  if (!layer.img) return null;

  if (mediaKind(layer.img) === 'video') {
    if (!url) return null;
    return (
      <video
        key={url}
        src={url}
        style={placement(sizeOf(layer.img), layer.pos, stage, scale)}
        autoPlay
        loop
        playsInline
        muted
        ref={(el) => {
          if (el) el.muted = muted; // React doesn't update `muted` reliably
        }}
        onLoadedMetadata={(e) => onSize(layer.img!, { w: e.currentTarget.videoWidth, h: e.currentTarget.videoHeight })}
      />
    );
  }

  const path = layer.img;
  const incomingReady = !!url && shown?.url === url;
  return (
    <>
      {/* The last fully loaded image stays until the incoming one is ready. */}
      {shown && !incomingReady && <img src={shown.url} alt="" draggable={false} style={placement(sizeOf(shown.path), shown.pos, stage, scale)} />}
      {url && (
        <img
          key={url}
          src={url}
          alt=""
          draggable={false}
          style={incomingReady ? placement(sizeOf(path), layer.pos, stage, scale) : { ...placement(sizeOf(path), layer.pos, stage, scale), opacity: 0 }}
          onLoad={(e) => {
            onSize(path, { w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight });
            setShown({ url, path, pos: layer.pos });
          }}
          onError={() => setShown(null)}
        />
      )}
    </>
  );
}

export function ScenePlayer({
  scene,
  index,
  programs,
  files,
  sceneForLabel,
  onSetPortrait,
  onClose,
  onContinue,
}: {
  onSetPortrait?: (charId: string, path: string) => void;
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
  // Sound: off by default; one tap enables it and the choice is remembered.
  const [soundOn, setSoundOn] = useState(() => {
    try {
      return localStorage.getItem('rpa.sound') === 'on';
    } catch {
      return false;
    }
  });
  const [volume, setVolume] = useState(() => {
    try {
      const v = parseFloat(localStorage.getItem('rpa.volume') ?? '');
      return v >= 0 && v <= 1 ? v : 0.7;
    } catch {
      return 0.7;
    }
  });
  const [soundMenu, setSoundMenu] = useState(false);
  const [settingsMenu, setSettingsMenu] = useState(false);
  const [hudHidden, setHudHidden] = useState(false);
  const [choiceHints, setChoiceHints] = useState(() => {
    try {
      return localStorage.getItem('rpa.choiceHints') !== 'off';
    } catch {
      return true;
    }
  });
  const toggleChoiceHints = () => {
    const next = !choiceHints;
    setChoiceHints(next);
    try {
      localStorage.setItem('rpa.choiceHints', next ? 'on' : 'off');
    } catch {
      /* storage unavailable */
    }
  };
  const menusOpen = soundMenu || settingsMenu;
  const closeMenus = () => {
    setSoundMenu(false);
    setSettingsMenu(false);
  };
  const audioBox = useRef<HTMLDivElement>(null);
  const setSound = (on: boolean) => {
    setSoundOn(on);
    try {
      localStorage.setItem('rpa.sound', on ? 'on' : 'off');
    } catch {
      /* storage unavailable */
    }
  };
  const changeVolume = (v: number) => {
    setVolume(v);
    try {
      localStorage.setItem('rpa.volume', String(v));
    } catch {
      /* storage unavailable */
    }
  };

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

  // Preload what the next taps will show; never evict what's on screen (or playing).
  const playing = Object.values(v.audio).filter((a) => !a.done).flatMap((a) => a.files);
  const onScreen = [v.bg?.img, ...v.layers.map((l) => l.img), v.video?.img, ...(soundOn ? playing : [])];
  media.setVisible(onScreen);
  usePlayerAudio({ audio: v.audio, enabled: soundOn, volume, urlFor: (p) => media.url(p), container: audioBox });
  const musicPlaying = !!v.audio.music && !v.audio.music.done;
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

  /**
   * Tap: left edge = back, anywhere else = next. Swipe right = back.
   * An open popover closes on an outside tap; hidden controls come back on any tap.
   */
  const onTap = (e: React.MouseEvent) => {
    if (swipe.current?.swiped) {
      swipe.current = null;
      return;
    }
    if (menusOpen) return closeMenus();
    if (hudHidden) return setHudHidden(false);
    if (e.clientX < box.w * BACK_ZONE) back();
    else advance();
  };

  // Latest UI state for the (stable) key handler.
  const keyState = useRef({ menusOpen, showLog, hudHidden, blocking: false });
  keyState.current = { menusOpen, showLog, hudHidden, blocking: !!(v.menu || v.branch) };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = keyState.current;
      if (e.key === 'Escape') {
        if (k.menusOpen) closeMenus();
        else if (k.showLog) setShowLog(false);
        else if (k.hudHidden) setHudHidden(false);
        else if (!document.fullscreenElement) onClose();
        return;
      }
      // Navigation keys do nothing while a popover, the log, a menu or an if-picker is open.
      if (k.menusOpen || k.showLog || k.blocking) return;
      if (e.key === ' ' || e.key === 'Enter' || e.key === 'ArrowRight') {
        e.preventDefault();
        advance();
      } else if (e.key === 'ArrowLeft' || e.key === 'Backspace') {
        e.preventDefault();
        back();
      }
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
  // "Use as portrait" targets whoever is speaking (or spoke last), if they're a gallery character.
  const lastWho = v.say?.who ?? engine.previousLine?.who ?? null;
  const portraitTarget = lastWho ? index.characters.find((c) => c.id === lastWho) : undefined;
  const next = v.ended?.nextLabel ? sceneForLabel(v.ended.nextLabel) : undefined;
  const frameImg = v.video?.img ?? [...v.layers].reverse().find((l) => l.img)?.img ?? v.bg?.img;
  const frameUrl = media.url(frameImg);
  const missingBg = v.bg && (!v.bg.img || media.failed(v.bg.img)) ? v.bg.name : null;
  const onSize = useCallback((path: string, sz: Size) => setSizes((m) => (m[path] ? m : { ...m, [path]: sz })), []);
  const sizeOf = useCallback((path: string) => sizes[path], [sizes]);
  const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();

  return (
    <div
      ref={root}
      className="fixed inset-0 z-[60] overflow-hidden bg-black select-none"
      onClick={onTap}
      onPointerDown={(e) => (swipe.current = { x: e.clientX, y: e.clientY, swiped: false })}
      onPointerUp={(e) => {
        const s0 = swipe.current;
        if (!s0 || menusOpen || hudHidden) return;
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
      <div ref={audioBox} hidden />

      {/* Stage */}
      <div
        className="absolute overflow-hidden"
        style={{ width: stage.w * scale, height: stage.h * scale, left: (box.w - stage.w * scale) / 2, top: (box.h - stage.h * scale) / 2 }}
      >
        {v.bg && (
          <StageMedia key="bg" muted={!soundOn || musicPlaying} layer={{ ...v.bg, pos: v.bg.pos ?? DEFAULT_POS }} url={media.url(v.bg.img)} stage={stage} scale={scale} sizeOf={sizeOf} onSize={onSize} />
        )}
        {v.layers.map((l) => (
          <StageMedia key={`layer:${l.tag}`} muted={!soundOn || musicPlaying} layer={l} url={media.url(l.img)} stage={stage} scale={scale} sizeOf={sizeOf} onSize={onSize} />
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
            <video
              key={media.url(v.video.img)}
              src={media.url(v.video.img)}
              autoPlay
              playsInline
              muted={!soundOn}
              ref={(el) => {
                if (el) el.muted = !soundOn;
              }}
              className="size-full object-contain"
              onEnded={advance}
              onError={advance}
            />
          ) : (
            <span className="text-sm text-neutral-500">{media.failed(v.video.img) || !v.video.img ? `video not found: ${v.video.name}` : 'Loading…'}</span>
          )}
        </div>
      )}

      {/* Top bar */}
      {!hudHidden && (
      <div className="absolute inset-x-0 top-0 z-30 bg-gradient-to-b from-black/75 to-transparent pt-[max(0.5rem,env(safe-area-inset-top))] pr-[max(0.75rem,env(safe-area-inset-right))] pb-5 pl-[max(0.75rem,env(safe-area-inset-left))]" onClick={stop} onPointerDown={stop} onPointerUp={stop}>
        <div className="flex items-center gap-1.5 sm:gap-2">
          <button type="button" onClick={onClose} className="grid size-9 shrink-0 place-items-center rounded-full bg-black/40" aria-label="Close player">
            <XIcon width={18} height={18} />
          </button>
          <p className="min-w-[3rem] flex-1 truncate text-xs font-semibold text-white/90">{scene.title}</p>
          {soundOn ? (
            <div className="relative shrink-0">
              <button
                type="button"
                onClick={() => {
                  setSettingsMenu(false);
                  setSoundMenu((o) => !o);
                }}
                className="grid size-9 place-items-center rounded-full bg-black/40"
                aria-label="Sound settings"
                aria-expanded={soundMenu}
                data-sound="on"
              >
                <SoundOnIcon width={18} height={18} />
              </button>
              {soundMenu && (
                <div className="absolute top-11 right-0 z-50 w-56 rounded-xl bg-neutral-900/95 p-3 ring-1 ring-white/15" data-sound-menu>
                  <label className="flex items-center gap-2 text-xs text-neutral-300">
                    Volume
                    <input type="range" min={0} max={1} step={0.05} value={volume} onChange={(e) => changeVolume(parseFloat(e.target.value))} className="flex-1 accent-rose-400" aria-label="Volume" />
                  </label>
                  <button
                    type="button"
                    onClick={() => {
                      setSound(false);
                      setSoundMenu(false);
                    }}
                    className="mt-2.5 w-full rounded-lg bg-white/10 py-1.5 text-xs font-medium"
                  >
                    Turn sound off
                  </button>
                </div>
              )}
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setSound(true)}
              className="flex shrink-0 items-center gap-1.5 rounded-full bg-white px-2.5 py-1.5 text-[12px] font-semibold text-neutral-950 active:scale-95 sm:px-3"
              aria-label="Turn sound on"
              data-sound="off"
            >
              <SoundOffIcon width={15} height={15} />
              <span className="hidden min-[380px]:inline">Sound off</span>
            </button>
          )}
          <button type="button" onClick={() => setHudHidden(true)} className="grid size-9 shrink-0 place-items-center rounded-full bg-black/40" aria-label="Hide controls" data-hide-hud>
            <EyeOffIcon width={17} height={17} />
          </button>
          <button type="button" onClick={() => setShowLog(true)} className="grid size-9 shrink-0 place-items-center rounded-full bg-black/40" aria-label="Scene log">
            <ListIcon width={17} height={17} />
          </button>
          <div className="relative shrink-0">
            <button
              type="button"
              onClick={() => {
                setSoundMenu(false);
                setSettingsMenu((o) => !o);
              }}
              className="grid size-9 place-items-center rounded-full bg-black/40"
              aria-label="Player settings"
              aria-expanded={settingsMenu}
            >
              <MoreIcon width={18} height={18} />
            </button>
            {settingsMenu && (
              <div className="absolute top-11 right-0 z-50 w-60 space-y-1 rounded-xl bg-neutral-900/95 p-2 text-sm ring-1 ring-white/15" data-settings-menu>
                <button type="button" onClick={toggleAutoBranch} className="flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-left hover:bg-white/5" aria-label="Branch mode">
                  <span>If-branches</span>
                  <span className="text-xs text-neutral-400">{autoBranch ? 'auto (first)' : 'ask'}</span>
                </button>
                <button type="button" onClick={toggleChoiceHints} className="flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-left hover:bg-white/5" aria-label="Choice hints" aria-pressed={choiceHints}>
                  <span>Choice hints</span>
                  <span className="text-xs text-neutral-400">{choiceHints ? 'on' : 'off'}</span>
                </button>
                {onSetPortrait && portraitTarget && frameImg && mediaKind(frameImg) === 'image' && (
                  <button
                    type="button"
                    onClick={() => {
                      onSetPortrait(portraitTarget.id, frameImg);
                      setSettingsMenu(false);
                    }}
                    className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left hover:bg-white/5"
                    data-use-portrait
                  >
                    <ImageIcon width={15} height={15} /> Use as {portraitTarget.name}'s portrait
                  </button>
                )}
                {frameUrl && frameImg && (
                  <button
                    type="button"
                    onClick={() => {
                      download(frameUrl, frameImg.slice(frameImg.lastIndexOf('/') + 1));
                      setSettingsMenu(false);
                    }}
                    className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left hover:bg-white/5"
                    aria-label="Save this image"
                  >
                    <DownloadIcon width={15} height={15} /> Save this image
                  </button>
                )}
              </div>
            )}
          </div>
          <button type="button" onClick={back} disabled={!engine.canGoBack} className="grid size-9 shrink-0 place-items-center rounded-full bg-black/40 disabled:opacity-30" aria-label="Back one line">
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
      )}

      {backHint && !hudHidden && (
        <div className="pointer-events-none absolute inset-y-0 left-0 flex w-[22%] items-center justify-center bg-gradient-to-r from-white/15 to-transparent" data-back-hint>
          <span className="rounded-full bg-black/60 px-3 py-1.5 text-center text-[11px] text-white">‹ Tap here to go back</span>
        </div>
      )}

      {/* Text box */}
      {v.say && !hudHidden && (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 via-black/70 to-transparent pt-10 pr-[max(1.25rem,env(safe-area-inset-right))] pb-[max(1rem,env(safe-area-inset-bottom))] pl-[max(1.25rem,env(safe-area-inset-left))]">
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
        <div className="absolute inset-0 overflow-y-auto bg-black/55 px-5 pt-[calc(6rem+env(safe-area-inset-top))] pb-8" onClick={stop} onPointerDown={stop} onPointerUp={stop}>
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
                {choiceHints && c.info && <ChoiceDetails info={c.info} programs={programs} scene={scene} sceneById={sceneById} titleForLabel={titleForLabel} />}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* If-branch picker */}
      {v.branch && (
        <div className="absolute inset-0 flex flex-col items-center overflow-y-auto bg-black/65 px-5 pt-[calc(6rem+env(safe-area-inset-top))] pb-8" onClick={stop} onPointerDown={stop} onPointerUp={stop}>
          <p className="mb-2.5 text-center text-xs text-neutral-300">The game checks its state here. Which way should it go?</p>
          {v.branch.map((b, i) => (
            <button key={i} type="button" onClick={() => choose(i)} className="mb-2.5 w-full max-w-lg rounded-xl bg-neutral-900/90 px-4 py-2.5 text-left ring-1 ring-sky-400/20 active:scale-[0.98]" data-branch>
              <span className="block font-mono text-[13px] text-sky-200">{b.cond === 'True' ? 'otherwise' : b.cond}</span>
              {choiceHints && b.info && <ChoiceDetails info={b.info} programs={programs} scene={scene} sceneById={sceneById} titleForLabel={titleForLabel} />}
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
