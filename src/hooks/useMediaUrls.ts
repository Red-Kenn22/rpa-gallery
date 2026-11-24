import { useCallback, useEffect, useReducer, useRef } from 'react';
import { loadAssetBlob } from '../lib/archiveClient';
import type { GalleryIndex } from '../types';

interface Entry {
  url?: string;
  failed?: boolean;
  used: number;
}

const MAX_URLS = 12;

/**
 * Object URLs for archive media, shared by the player: loads on demand,
 * preloads (and pre-decodes) upcoming images, keeps at most MAX_URLS alive
 * and revokes the least recently used ones that aren't on screen.
 */
export function useMediaUrls(index: GalleryIndex, files: File[] | null) {
  const cache = useRef(new Map<string, Entry>());
  const visible = useRef(new Set<string>());
  const [, rerender] = useReducer((x: number) => x + 1, 0);

  useEffect(() => {
    const map = cache.current;
    return () => {
      for (const e of map.values()) if (e.url) URL.revokeObjectURL(e.url);
      map.clear();
    };
  }, []);

  const evict = useCallback(() => {
    const map = cache.current;
    if (map.size <= MAX_URLS) return;
    const old = [...map.entries()].filter(([p]) => !visible.current.has(p)).sort((a, b) => a[1].used - b[1].used);
    for (const [p, e] of old.slice(0, map.size - MAX_URLS)) {
      if (e.url) URL.revokeObjectURL(e.url);
      map.delete(p);
    }
  }, []);

  const load = useCallback(
    (path: string, notify: boolean): Entry | undefined => {
      const map = cache.current;
      let e = map.get(path);
      if (e) {
        e.used = performance.now();
        return e;
      }
      const asset = index.assets[path];
      if (!asset || !files) return undefined;
      e = { used: performance.now() };
      map.set(path, e);
      const entry = e;
      loadAssetBlob(files, asset).then(
        (blob) => {
          if (map.get(path) !== entry) return;
          entry.url = URL.createObjectURL(blob);
          if (asset.kind === 'image') {
            // Warm the decoder so the next tap shows the image instantly.
            const img = new Image();
            img.src = entry.url;
            img.decode?.().catch(() => {});
          }
          evict();
          if (notify) rerender();
        },
        () => {
          entry.failed = true;
          if (notify) rerender();
        },
      );
      return e;
    },
    [index, files, evict],
  );

  /** URL for a path that is about to be shown (undefined while loading). */
  const url = useCallback((path: string | null | undefined): string | undefined => (path ? load(path, true)?.url : undefined), [load]);
  const failed = useCallback((path: string | null | undefined) => !!(path && cache.current.get(path)?.failed), []);
  const preload = useCallback((paths: string[]) => paths.forEach((p) => load(p, false)), [load]);
  const setVisible = useCallback((paths: (string | null | undefined)[]) => {
    visible.current = new Set(paths.filter((p): p is string => !!p));
  }, []);

  return { url, failed, preload, setVisible };
}
