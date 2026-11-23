/** Messages between the UI thread and archive.worker.ts. */

import type { GalleryIndex, IndexProgress } from '../types';

export type WorkerRequest =
  /** File objects are structured-cloned as handles; no bytes are copied. */
  { type: 'index'; id: number; files: File[] };

export type WorkerResponse =
  | { type: 'progress'; id: number; progress: IndexProgress }
  | { type: 'done'; id: number; index: GalleryIndex }
  | { type: 'error'; id: number; message: string; cancelled?: boolean };
