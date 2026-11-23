/**
 * IndexedDB cache.
 *
 *   indexes  – GalleryIndex keyed by `${name}_${size}_${lastModified}` (per
 *              source, sorted, "|"-joined), so reopening the same archives is
 *              instant.
 *   thumbs   – JPEG data URLs keyed by `${indexKey}::${assetPath}`.
 *
 * Archive bytes are never stored. Every call degrades to a no-op when
 * IndexedDB is unavailable (some private-browsing modes).
 */

import type { GalleryIndex } from '../types';

const DB_NAME = 'rpa-gallery';
const DB_VERSION = 1;
const INDEXES = 'indexes';
const THUMBS = 'thumbs';

export interface CachedIndexSummary {
  key: string;
  savedAt: number;
  sources: string[];
  scenes: number;
  characters: number;
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
  return rec?.index?.schema === 2 ? rec.index : null;
}

export async function putCachedIndex(index: GalleryIndex): Promise<void> {
  const rec: IndexRecord = { key: index.key, savedAt: Date.now(), index };
  await withStore(INDEXES, 'readwrite', (s) => s.put(rec));
  // Ask the browser not to evict our cache under storage pressure (best effort).
  void navigator.storage?.persist?.().catch(() => false);
}

export async function listCachedIndexes(): Promise<CachedIndexSummary[]> {
  const all = (await withStore<IndexRecord[]>(INDEXES, 'readonly', (s) => s.getAll())) ?? [];
  return all
    .filter((r) => r.index?.schema === 2)
    .map((r) => ({
      key: r.key,
      savedAt: r.savedAt,
      sources: r.index.sources.map((s) => s.name),
      scenes: r.index.scenes.length,
      characters: r.index.characters.length,
    }))
    .sort((a, b) => b.savedAt - a.savedAt);
}

export async function deleteCachedIndex(key: string): Promise<void> {
  await withStore(INDEXES, 'readwrite', (s) => s.delete(key));
  await withStore(THUMBS, 'readwrite', (s) => s.delete(IDBKeyRange.bound(`${key}::`, `${key}::￿`)));
}

export async function clearCache(): Promise<void> {
  await withStore(INDEXES, 'readwrite', (s) => s.clear());
  await withStore(THUMBS, 'readwrite', (s) => s.clear());
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
