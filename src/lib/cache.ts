/**
 * IndexedDB cache.
 *
 *   indexes  – GalleryIndex keyed by `${name}_${size}_${lastModified}` (per
 *              source, sorted, "|"-joined), so reopening the same archives is
 *              instant.
 *   thumbs   – JPEG data URLs keyed by `${indexKey}::${assetPath}`.
 *   programs – compiled scene-player programs, keyed by index key (loaded lazily).
 *   handles  – remembered FileSystemFileHandles per index key (Chrome only), so
 *              a game can be reopened with its files in one tap.
 *
 * Archive bytes are never stored. Every call degrades to a no-op when
 * IndexedDB is unavailable (some private-browsing modes).
 */

import type { GalleryIndex, ScenePrograms } from '../types';

const DB_NAME = 'rpa-gallery';
const DB_VERSION = 3;
const INDEXES = 'indexes';
const THUMBS = 'thumbs';
const PROGRAMS = 'programs';
const HANDLES = 'handles';

export interface CachedIndexSummary {
  key: string;
  savedAt: number;
  sources: string[];
  scenes: number;
  characters: number;
  /** The game's files can be reopened from remembered handles. */
  remembered: boolean;
}

interface IndexRecord {
  key: string;
  savedAt: number;
  index: GalleryIndex;
}

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') return resolve(null);
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      return resolve(null);
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(INDEXES)) db.createObjectStore(INDEXES, { keyPath: 'key' });
      if (!db.objectStoreNames.contains(THUMBS)) db.createObjectStore(THUMBS);
      if (!db.objectStoreNames.contains(PROGRAMS)) db.createObjectStore(PROGRAMS);
      if (!db.objectStoreNames.contains(HANDLES)) db.createObjectStore(HANDLES);
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
  return dbPromise;
}

function done<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore<T>(
  name: string,
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T> | Promise<T>,
): Promise<T | undefined> {
  const db = await openDb();
  if (!db) return undefined;
  try {
    const tx = db.transaction(name, mode);
    // Attach every handler before the transaction can finish.
    const completed =
      mode === 'readwrite'
        ? new Promise<void>((resolve, reject) => {
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error);
          })
        : Promise.resolve();
    const r = fn(tx.objectStore(name));
    const value = r instanceof IDBRequest ? done(r) : r;
    const [result] = await Promise.all([value, completed]);
    return result;
  } catch (e) {
    console.warn('[cache]', e);
    return undefined;
  }
}

// ─── Indexes ────────────────────────────────────────────────────────────────

export async function getCachedIndex(key: string): Promise<GalleryIndex | null> {
  const rec = await withStore<IndexRecord | undefined>(INDEXES, 'readonly', (s) => s.get(key));
  return rec?.index?.schema === 8 ? rec.index : null;
}

export async function putCachedIndex(index: GalleryIndex): Promise<void> {
  const rec: IndexRecord = { key: index.key, savedAt: Date.now(), index };
  await withStore(INDEXES, 'readwrite', (s) => s.put(rec));
  // Ask the browser not to evict our cache under storage pressure (best effort).
  void navigator.storage?.persist?.().catch(() => false);
}

export async function listCachedIndexes(): Promise<CachedIndexSummary[]> {
  const all = (await withStore<IndexRecord[]>(INDEXES, 'readonly', (s) => s.getAll())) ?? [];
  const remembered = new Set(((await withStore<IDBValidKey[]>(HANDLES, 'readonly', (s) => s.getAllKeys())) ?? []).map(String));
  return all
    .filter((r) => r.index?.schema === 8)
    .map((r) => ({
      key: r.key,
      savedAt: r.savedAt,
      sources: r.index.sources.map((s) => s.name),
      scenes: r.index.scenes.length,
      characters: r.index.characters.length,
      remembered: remembered.has(r.key),
    }))
    .sort((a, b) => b.savedAt - a.savedAt);
}

export async function deleteCachedIndex(key: string): Promise<void> {
  await withStore(INDEXES, 'readwrite', (s) => s.delete(key));
  await withStore(PROGRAMS, 'readwrite', (s) => s.delete(key));
  await withStore(HANDLES, 'readwrite', (s) => s.delete(key));
  await withStore(THUMBS, 'readwrite', (s) => s.delete(IDBKeyRange.bound(`${key}::`, `${key}::￿`)));
}

export async function clearCache(): Promise<void> {
  await withStore(INDEXES, 'readwrite', (s) => s.clear());
  await withStore(PROGRAMS, 'readwrite', (s) => s.clear());
  await withStore(HANDLES, 'readwrite', (s) => s.clear());
  await withStore(THUMBS, 'readwrite', (s) => s.clear());
}

// ─── Remembered files ───────────────────────────────────────────────────────

export async function putHandles(indexKey: string, handles: FileSystemFileHandle[]): Promise<void> {
  await withStore(HANDLES, 'readwrite', (s) => s.put(handles, indexKey));
}

export async function getHandles(indexKey: string): Promise<FileSystemFileHandle[] | null> {
  const v = await withStore<FileSystemFileHandle[] | undefined>(HANDLES, 'readonly', (s) => s.get(indexKey));
  return Array.isArray(v) && v.length ? v : null;
}

export async function forgetHandles(indexKey: string): Promise<void> {
  await withStore(HANDLES, 'readwrite', (s) => s.delete(indexKey));
}

// ─── Thumbnails ─────────────────────────────────────────────────────────────

const thumbKey = (indexKey: string, path: string) => `${indexKey}::${path}`;

export async function getCachedThumb(indexKey: string, path: string): Promise<string | null> {
  const v = await withStore<string | undefined>(THUMBS, 'readonly', (s) => s.get(thumbKey(indexKey, path)));
  return typeof v === 'string' ? v : null;
}

export async function putCachedThumb(indexKey: string, path: string, dataUrl: string): Promise<void> {
  await withStore(THUMBS, 'readwrite', (s) => s.put(dataUrl, thumbKey(indexKey, path)));
}

// ─── Scene player programs ──────────────────────────────────────────────────

export async function getCachedPrograms(indexKey: string): Promise<ScenePrograms | null> {
  const v = await withStore<ScenePrograms | undefined>(PROGRAMS, 'readonly', (s) => s.get(indexKey));
  return v?.schema === 1 ? v : null;
}

export async function putCachedPrograms(indexKey: string, programs: ScenePrograms): Promise<void> {
  await withStore(PROGRAMS, 'readwrite', (s) => s.put(programs, indexKey));
}
