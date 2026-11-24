/**
 * Dedicated worker: archive indexing, .rpyc decompression/unpickling, AST
 * walking and scene building all happen here so the UI never blocks.
 *
 * Created by lib/archiveClient.ts with
 *   new Worker(new URL('../workers/archive.worker.ts', import.meta.url), { type: 'module' })
 */

import { buildGalleryIndex, IndexCancelledError, sourceFromFile } from '../lib/indexer';
import type { WorkerRequest, WorkerResponse } from './protocol';

// Minimal typing so this file compiles alongside the DOM lib.
const scope = self as unknown as {
  postMessage(msg: WorkerResponse): void;
  addEventListener(type: 'message', fn: (ev: MessageEvent<WorkerRequest>) => void): void;
};

/** Progress is throttled so a 10k-file archive doesn't flood the UI thread. */
const PROGRESS_INTERVAL_MS = 80;

scope.addEventListener('message', async (ev) => {
  const msg = ev.data;
  if (msg?.type !== 'index') return;
  const { id, files } = msg;
  let lastProgress = 0;

  try {
    const { index, programs } = await buildGalleryIndex(files.map(sourceFromFile), {
      onProgress(progress) {
        const now = Date.now();
        const final = progress.done === progress.total;
        if (!final && now - lastProgress < PROGRESS_INTERVAL_MS) return;
        lastProgress = now;
        scope.postMessage({ type: 'progress', id, progress });
      },
    });
    scope.postMessage({ type: 'done', id, index, programs });
  } catch (e) {
    scope.postMessage({
      type: 'error',
      id,
      message: (e as Error)?.message ?? String(e),
      cancelled: e instanceof IndexCancelledError,
    });
  }
});
