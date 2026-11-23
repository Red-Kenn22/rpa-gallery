import { useEffect, useState } from 'react';
import { assetBlob } from '../lib/archiveClient';
import { getCachedThumb, putCachedThumb } from '../lib/cache';
import { makeThumbnail, thumbnailQueue } from '../lib/thumbnailer';
import type { GalleryIndex, SceneInfo } from '../types';

export type ThumbState = { src: string | null; status: 'idle' | 'loading' | 'ready' | 'failed' };

/** Assets to try, best first: the chosen thumbnail, then backgrounds, then other images. */
function candidates(scene: SceneInfo): string[] {
  const list = [scene.thumbnail?.path, ...scene.backgrounds, ...scene.images, ...scene.videos];
  return [...new Set(list.filter((p): p is string => !!p))].slice(0, 4);
}

/**
 * Lazily produces a card thumbnail once `active` (in view): IndexedDB cache
 * first, then the shared decode queue. Leaving the viewport aborts a queued job.
 */
export function useThumbnail(index: GalleryIndex, scene: SceneInfo, files: File[] | null, active: boolean): ThumbState {
  const [state, setState] = useState<ThumbState>({ src: null, status: 'idle' });

  useEffect(() => {
    if (!active || state.status === 'ready' || state.status === 'failed') return;
    const paths = candidates(scene);
    if (!paths.length) {
      setState({ src: null, status: 'failed' });
      return;
    }
    const ac = new AbortController();
    setState((s) => ({ ...s, status: 'loading' }));

    (async () => {
      for (const path of paths) {
        const cached = await getCachedThumb(index.key, path);
        if (ac.signal.aborted) return;
        if (cached) return setState({ src: cached, status: 'ready' });
      }
      if (!files) return setState({ src: null, status: 'idle' });

      for (const path of paths) {
        const asset = index.assets[path];
        if (!asset || (asset.kind !== 'image' && asset.kind !== 'video')) continue;
        try {
          const kind = asset.kind;
          const url = await thumbnailQueue.add(() => makeThumbnail(assetBlob(files, asset), kind), ac.signal);
          if (ac.signal.aborted) return;
          setState({ src: url, status: 'ready' });
          void putCachedThumb(index.key, path, url);
          return;
        } catch (e) {
          if (ac.signal.aborted || (e as Error)?.name === 'AbortError') return;
          // e.g. a codec this phone can't decode: try the next candidate
        }
      }
      setState({ src: null, status: 'failed' });
    })();

    return () => ac.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, index.key, scene.id, files]);

  return state;
}
