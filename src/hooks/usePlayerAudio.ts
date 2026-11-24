import { useEffect, useRef, type RefObject } from 'react';
import type { AudioState } from '../lib/playerEngine';

interface Channel {
  el: HTMLAudioElement;
  /** Playback generation currently loaded (-1 = idle). */
  seq: number;
  /** Position in a playlist (`queue` / list of files). */
  idx: number;
  fade: number | null;
}

const FADE_MS = 600;

function rampVolume(ch: Channel, to: number, ms: number, then?: () => void): void {
  if (ch.fade !== null) cancelAnimationFrame(ch.fade);
  const from = ch.el.volume;
  const t0 = performance.now();
  const tick = () => {
    const f = Math.min(1, (performance.now() - t0) / ms);
    ch.el.volume = Math.max(0, Math.min(1, from + (to - from) * f));
    if (f < 1) ch.fade = requestAnimationFrame(tick);
    else {
      ch.fade = null;
      then?.();
    }
  };
  ch.fade = requestAnimationFrame(tick);
}

/**
 * Plays the engine's audio channels with one <audio> element each (kept in
 * `container` so they're inspectable). Music fades in/out and crossfades;
 * one-shots play once; playlists advance on `ended`. Nothing plays until
 * `enabled` (sound is off by default).
 */
export function usePlayerAudio({
  audio,
  enabled,
  volume,
  urlFor,
  container,
}: {
  audio: Record<string, AudioState>;
  enabled: boolean;
  volume: number;
  urlFor: (path: string) => string | undefined;
  container: RefObject<HTMLDivElement | null>;
}): void {
  const channels = useRef(new Map<string, Channel>());
  const latest = useRef(audio);
  latest.current = audio;
  const urlRef = useRef(urlFor);
  urlRef.current = urlFor;
  const volRef = useRef(volume);
  volRef.current = volume;

  const getChannel = (name: string): Channel => {
    let ch = channels.current.get(name);
    if (!ch) {
      const el = document.createElement('audio');
      el.dataset.channel = name;
      el.preload = 'auto';
      container.current?.appendChild(el);
      const created: Channel = { el, seq: -1, idx: 0, fade: null };
      el.addEventListener('ended', () => {
        // Playlists: next file, wrapping when the channel loops.
        const want = latest.current[name];
        if (!want || want.seq !== created.seq || want.files.length < 2) return;
        let next = created.idx + 1;
        if (next >= want.files.length) {
          if (!want.loop) return;
          next = 0;
        }
        const url = urlRef.current(want.files[next]);
        if (!url) return;
        created.idx = next;
        el.src = url;
        void el.play().catch(() => {});
      });
      ch = created;
      channels.current.set(name, ch);
    }
    return ch;
  };

  useEffect(() => {
    const map = channels.current;
    if (!enabled) {
      for (const ch of map.values()) {
        ch.el.pause();
        ch.seq = -1;
      }
      return;
    }
    for (const [name, want] of Object.entries(audio)) {
      if (want.done) continue; // already played earlier: never restart
      const ch = getChannel(name);
      if (ch.seq === want.seq) continue;
      const url = urlFor(want.files[0]);
      if (!url) continue; // still loading; the next render retries
      ch.seq = want.seq;
      ch.idx = 0;
      const start = () => {
        ch.el.src = url;
        ch.el.loop = want.loop && want.files.length === 1;
        const isMusic = want.loop;
        ch.el.volume = isMusic ? 0 : volRef.current;
        void ch.el.play().catch(() => {});
        if (isMusic) rampVolume(ch, volRef.current, FADE_MS);
      };
      // Crossfade: fade the old track out first when music changes.
      if (!ch.el.paused && want.loop) rampVolume(ch, 0, FADE_MS / 2, start);
      else start();
    }
    for (const [name, ch] of map) {
      if (!audio[name] && ch.seq !== -1) {
        ch.seq = -1;
        rampVolume(ch, 0, name === 'voice' ? 120 : FADE_MS, () => ch.el.pause());
      }
    }
  });

  useEffect(() => {
    for (const ch of channels.current.values()) if (ch.fade === null && !ch.el.paused) ch.el.volume = volume;
  }, [volume]);

  useEffect(() => {
    const map = channels.current;
    return () => {
      for (const ch of map.values()) {
        if (ch.fade !== null) cancelAnimationFrame(ch.fade);
        ch.el.pause();
        ch.el.removeAttribute('src');
        ch.el.load();
        ch.el.remove();
      }
      map.clear();
    };
  }, []);
}
