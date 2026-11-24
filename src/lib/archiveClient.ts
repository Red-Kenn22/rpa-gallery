/**
 * UI-thread side of the archive worker.
 *
 *   const job = indexFiles(files, (p) => setProgress(p));
 *   const { index, programs } = await job.promise;   // job.cancel() to abort
 *   const blob = await loadAssetBlob(files, index.assets[path]);
 */

import { inflateRaw } from 'pako';
import type { AssetRef, IndexProgress } from '../types';
import type { WorkerRequest, WorkerResponse } from '../workers/protocol';
import type { IndexResult } from './indexer';
import { entryBlob, readRange } from './rpaParser';

export { cacheKeyFor } from './cacheKey';

let worker: Worker | null = null;
let nextId = 1;

function getWorker(): Worker {
  worker ??= new Worker(new URL('../workers/archive.worker.ts', import.meta.url), { type: 'module' });
  return worker;
}

export class IndexAbortedError extends Error {
  constructor() {
    super('Indexing was cancelled');
    this.name = 'AbortError';
  }
}

export interface IndexJob {
  promise: Promise<IndexResult>;
  /** Stops immediately (terminates the worker, even mid-file). */
  cancel(): void;
}

export function indexFiles(files: File[], onProgress?: (p: IndexProgress) => void): IndexJob {
  const id = nextId++;
  const w = getWorker();
  let settle: { resolve: (v: IndexResult) => void; reject: (e: unknown) => void } | null = null;

  const cleanup = () => {
    w.removeEventListener('message', onMessage);
    w.removeEventListener('error', onError);
    settle = null;
  };
  const onMessage = (ev: MessageEvent<WorkerResponse>) => {
    const msg = ev.data;
    if (msg.id !== id || !settle) return;
    if (msg.type === 'progress') onProgress?.(msg.progress);
    else if (msg.type === 'done') {
      settle.resolve({ index: msg.index, programs: msg.programs });
      cleanup();
    } else {
      settle.reject(msg.cancelled ? new IndexAbortedError() : new Error(msg.message));
      cleanup();
    }
  };
  const onError = (ev: ErrorEvent) => {
    settle?.reject(new Error(ev.message || 'Archive worker crashed'));
    cleanup();
    worker?.terminate();
    worker = null;
  };

  const promise = new Promise<IndexResult>((resolve, reject) => {
    settle = { resolve, reject };
    w.addEventListener('message', onMessage);
    w.addEventListener('error', onError);
    const req: WorkerRequest = { type: 'index', id, files };
    w.postMessage(req);
  });

  return {
    promise,
    cancel() {
      if (!settle) return;
      settle.reject(new IndexAbortedError());
      cleanup();
      // Terminating is the only way to stop a long unpickle mid-file.
      worker?.terminate();
      worker = null;
    },
  };
}

/**
 * Blob for an indexed asset, read from the user's original File.
 * Stored data is a lazy slice (nothing read until used); data that is
 * deflate-compressed inside an APK is inflated here (small files only in practice).
 * `files` must be in `index.sources` order.
 */
export async function loadAssetBlob(files: Blob[], asset: AssetRef): Promise<Blob> {
  const file = files[asset.source];
  if (!file) throw new Error(`Source file #${asset.source} for ${asset.path} is not loaded`);
  if (asset.deflated) {
    const raw = await readRange(file, asset.offset, asset.offset + asset.deflated.compressedLength);
    return new Blob([inflateRaw(raw)], { type: asset.mime });
  }
  return entryBlob(file, asset, asset.mime);
}
