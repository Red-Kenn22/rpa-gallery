import { useEffect, useState } from 'react';
import { loadAssetBlob } from '../lib/archiveClient';
import { getCachedThumb, putCachedThumb } from '../lib/cache';
import { makeThumbnail, thumbnailQueue } from '../lib/thumbnailer';
import type { GalleryIndex } from '../types';

/**
 * Thumbnail for one archive image/video path (cache first, then the shared
 * decode queue), produced once `active`. Used for portraits and pickers.
 */
export function useAssetThumbnail(
  index: GalleryIndex,
  path: string | undefined,
  files: File[] | null,
  active: boolean,
  maxSize = 480,
  crop: 'none' | 'portrait' = 'none',
): string | null {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    setSrc(null);
    if (!active || !path) return;
    const ac = new AbortController();
    (async () => {
      // Portrait crops are cached apart from the plain thumbnail of the same file.
      const cacheKey = crop === 'portrait' ? `${path}#portrait` : path;
      const cached = await getCachedThumb(index.key, cacheKey);
      if (ac.signal.aborted) return;
      if (cached) return setSrc(cached);
      const asset = index.assets[path];
      if (!files || !asset || (asset.kind !== 'image' && asset.kind !== 'video')) return;
      try {
        const kind = asset.kind;
        const url = await thumbnailQueue.add(async () => makeThumbnail(await loadAssetBlob(files, asset), kind, { maxSize, crop }), ac.signal);
        if (ac.signal.aborted) return;
        setSrc(url);
        void putCachedThumb(index.key, cacheKey, url);
      } catch {
        /* undecodable: leave the placeholder */
      }
    })();
    return () => ac.abort();
  }, [index, path, files, active, maxSize, crop]);
  return src;
}
