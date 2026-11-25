/** Auto-play timing (no React, so the tests can import it). */
import type { PlayerView } from './playerEngine';

/** Speeds offered by the speed chip, in order. */
export const AUTO_SPEEDS = [0.5, 1, 1.5, 2, 3] as const;

/** Reading time at 1×: a short pause plus ~20 characters a second. */
const BASE_MS = 1200;
const MS_PER_CHAR = 50;
/** Image-only beats and pauses. */
const BEAT_MS = 2500;
/** Gap after a voice line finishes before moving on. */
export const AFTER_VOICE_MS = 500;

/**
 * How long auto-play waits at this stop, or null where it must not move on by
 * itself: menus, if-pickers, the end screen, and cutscenes (they advance when
 * the video ends).
 */
export function autoDelayMs(view: Pick<PlayerView, 'say' | 'menu' | 'branch' | 'ended' | 'video'>, speed: number): number | null {
  if (view.ended || view.menu || view.branch || view.video) return null;
  const s = speed > 0 ? speed : 1;
  if (view.say) return (BASE_MS + view.say.what.length * MS_PER_CHAR) / s;
  return BEAT_MS / s;
}
