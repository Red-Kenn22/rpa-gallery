import { useEffect, useRef } from 'react';
import { AFTER_VOICE_MS, autoDelayMs } from '../lib/autoPlay';
import type { PlayerView } from '../lib/playerEngine';

export { AUTO_SPEEDS } from '../lib/autoPlay';

const POLL_MS = 150;


/**
 * Moves the player on by itself. Waits for the reading time, then for any
 * voice line to finish and the stop's images to load. `stopKey` changes at
 * every stop (tap, back, choice, jump) and restarts the wait.
 */
export function useAutoPlay({
  enabled,
  paused,
  speed,
  view,
  stopKey,
  voiceBusy,
  ready,
  onAdvance,
}: {
  enabled: boolean;
  /** A popover, the log or hidden-tab: hold, and start the wait again after. */
  paused: boolean;
  speed: number;
  view: PlayerView;
  stopKey: number;
  voiceBusy: () => boolean;
  ready: () => boolean;
  onAdvance: () => void;
}): number | null {
  const latest = useRef({ voiceBusy, ready, onAdvance });
  latest.current = { voiceBusy, ready, onAdvance };
  const delay = enabled && !paused ? autoDelayMs(view, speed) : null;

  useEffect(() => {
    if (delay === null) return;
    const t0 = performance.now();
    let voiceSeen = 0;
    const id = window.setInterval(() => {
      const now = performance.now();
      if (document.hidden) return;
      if (latest.current.voiceBusy()) {
        voiceSeen = now;
        return;
      }
      if (now - t0 < delay) return;
      if (voiceSeen && now - voiceSeen < AFTER_VOICE_MS / Math.max(speed, 1)) return;
      if (!latest.current.ready()) return;
      window.clearInterval(id);
      latest.current.onAdvance();
    }, POLL_MS);
    return () => window.clearInterval(id);
  }, [delay, stopKey, speed]);

  // Keep the screen on while it plays.
  useEffect(() => {
    if (!enabled) return;
    type WakeLock = { release: () => Promise<void> };
    const nav = navigator as Navigator & { wakeLock?: { request: (t: 'screen') => Promise<WakeLock> } };
    if (!nav.wakeLock) return;
    let lock: WakeLock | null = null;
    let cancelled = false;
    const acquire = () => {
      if (document.visibilityState !== 'visible') return;
      nav.wakeLock!
        .request('screen')
        .then((l) => {
          if (cancelled) void l.release().catch(() => {});
          else lock = l;
        })
        .catch(() => {});
    };
    acquire();
    document.addEventListener('visibilitychange', acquire);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', acquire);
      void lock?.release().catch(() => {});
    };
  }, [enabled]);

  return delay;
}
