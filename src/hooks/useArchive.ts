import { useCallback, useEffect, useRef, useState } from 'react';
import { cacheKeyFor, indexFiles, IndexAbortedError, type IndexJob } from '../lib/archiveClient';
import { getCachedIndex, putCachedIndex } from '../lib/cache';
import type { GalleryIndex, IndexProgress } from '../types';

export type ArchiveState =
  | { status: 'idle' }
  | { status: 'indexing'; progress: IndexProgress | null; fileNames: string[] }
  | {
      status: 'ready';
      index: GalleryIndex;
      /** Files in `index.sources` order, or null when opened from cache without them. */
      files: File[] | null;
      fromCache: boolean;
    }
  | { status: 'error'; message: string };

/** Puts the picked files in the order the index expects, or null if any is missing. */
export function orderFiles(index: GalleryIndex, files: File[]): File[] | null {
  const out: File[] = [];
  for (const s of index.sources) {
    const f = files.find((x) => x.name === s.name && x.size === s.size && x.lastModified === s.lastModified)
      ?? files.find((x) => x.name === s.name && x.size === s.size);
    if (!f) return null;
    out.push(f);
  }
  return out;
}

export function useArchive() {
  const [state, setState] = useState<ArchiveState>({ status: 'idle' });
  const jobRef = useRef<IndexJob | null>(null);

  useEffect(() => () => jobRef.current?.cancel(), []);

  const open = useCallback(async (picked: File[]) => {
    if (!picked.length) return;
    jobRef.current?.cancel();
    const key = cacheKeyFor(picked);

    const cached = await getCachedIndex(key);
    if (cached) {
      setState({ status: 'ready', index: cached, files: orderFiles(cached, picked), fromCache: true });
      return;
    }

    setState({ status: 'indexing', progress: null, fileNames: picked.map((f) => f.name) });
    const job = indexFiles(picked, (progress) =>
      setState((s) => (s.status === 'indexing' ? { ...s, progress } : s)),
    );
    jobRef.current = job;
    try {
      const index = await job.promise;
      if (jobRef.current !== job) return;
      jobRef.current = null;
      void putCachedIndex(index);
      setState({ status: 'ready', index, files: orderFiles(index, picked), fromCache: false });
    } catch (e) {
      if (jobRef.current !== job) return;
      jobRef.current = null;
      if (e instanceof IndexAbortedError) setState({ status: 'idle' });
      else setState({ status: 'error', message: (e as Error)?.message ?? String(e) });
    }
  }, []);

  /** Opens a cached index without files (dialogue + cached thumbnails only). */
  const openCached = useCallback(async (key: string) => {
    const cached = await getCachedIndex(key);
    if (cached) setState({ status: 'ready', index: cached, files: null, fromCache: true });
    else setState({ status: 'error', message: 'That archive is no longer in the cache.' });
  }, []);

  /** Re-attaches files to a cached index. Returns false if they don't match. */
  const attachFiles = useCallback(
    (picked: File[]): boolean => {
      if (state.status !== 'ready') return false;
      const ordered = orderFiles(state.index, picked);
      if (!ordered) return false;
      setState({ ...state, files: ordered });
      return true;
    },
    [state],
  );

  const cancel = useCallback(() => {
    jobRef.current?.cancel();
    jobRef.current = null;
    setState({ status: 'idle' });
  }, []);

  const close = useCallback(() => {
    jobRef.current?.cancel();
    jobRef.current = null;
    setState({ status: 'idle' });
  }, []);

  return { state, open, openCached, attachFiles, cancel, close };
}
