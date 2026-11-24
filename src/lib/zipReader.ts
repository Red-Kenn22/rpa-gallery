/**
 * Minimal ZIP reader for APKs, using byte-range reads only.
 *
 * Reads the end-of-central-directory record and the central directory (a few
 * MB at most), never the whole file. Stored entries can then be sliced
 * straight out of the original Blob; deflated entries are inflated on demand.
 * Supports ZIP64 for archives and entries over 4 GB.
 */

import { inflateRaw } from 'pako';
import { readRange } from './rpaParser';

export interface ZipEntry {
  name: string;
  /** 0 = stored, 8 = deflate. */
  method: number;
  compressedSize: number;
  size: number;
  localHeaderOffset: number;
}

export class ZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipError';
  }
}

const EOCD_SIG = 0x06054b50;
const ZIP64_LOCATOR_SIG = 0x07064b50;
const ZIP64_EOCD_SIG = 0x06064b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
const MAX_COMMENT = 0xffff;

const utf8 = new TextDecoder('utf-8');

function u64(view: DataView, pos: number): number {
  const v = view.getUint32(pos, true) + view.getUint32(pos + 4, true) * 0x100000000;
  if (!Number.isSafeInteger(v)) throw new ZipError('ZIP offset exceeds 2^53');
  return v;
}

/** Lists every entry in a ZIP/APK. */
export async function readZipDirectory(zip: Blob): Promise<ZipEntry[]> {
  if (zip.size < 22) throw new ZipError('File is too small to be a ZIP/APK');
  const tailStart = Math.max(0, zip.size - (22 + MAX_COMMENT + 20));
  const tail = await readRange(zip, tailStart, zip.size);
  const tv = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);

  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tv.getUint32(i, true) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipError('Not a ZIP/APK file (no end-of-directory record)');

  let count = tv.getUint16(eocd + 10, true);
  let cdSize = tv.getUint32(eocd + 12, true);
  let cdOffset = tv.getUint32(eocd + 16, true);

  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    const loc = eocd - 20;
    if (loc < 0 || tv.getUint32(loc, true) !== ZIP64_LOCATOR_SIG) throw new ZipError('ZIP64 locator missing');
    const z64Offset = u64(tv, loc + 8);
    const rec = await readRange(zip, z64Offset, z64Offset + 56);
    const rv = new DataView(rec.buffer, rec.byteOffset, rec.byteLength);
    if (rv.getUint32(0, true) !== ZIP64_EOCD_SIG) throw new ZipError('ZIP64 end-of-directory record missing');
    count = u64(rv, 32);
    cdSize = u64(rv, 40);
    cdOffset = u64(rv, 48);
  }
  if (cdOffset + cdSize > zip.size) throw new ZipError('Central directory lies outside the file');

  const cd = await readRange(zip, cdOffset, cdOffset + cdSize);
  const v = new DataView(cd.buffer, cd.byteOffset, cd.byteLength);
  const entries: ZipEntry[] = [];
  let pos = 0;
  for (let n = 0; n < count && pos + 46 <= cd.length; n++) {
    if (v.getUint32(pos, true) !== CENTRAL_SIG) throw new ZipError(`Corrupt central directory at entry ${n}`);
    const method = v.getUint16(pos + 10, true);
    let compressedSize = v.getUint32(pos + 20, true);
    let size = v.getUint32(pos + 24, true);
    const nameLen = v.getUint16(pos + 28, true);
    const extraLen = v.getUint16(pos + 30, true);
    const commentLen = v.getUint16(pos + 32, true);
    let localHeaderOffset = v.getUint32(pos + 42, true);
    const name = utf8.decode(cd.subarray(pos + 46, pos + 46 + nameLen));

    // ZIP64 extended information extra field (0x0001)
    if (size === 0xffffffff || compressedSize === 0xffffffff || localHeaderOffset === 0xffffffff) {
      let e = pos + 46 + nameLen;
      const end = e + extraLen;
      while (e + 4 <= end) {
        const id = v.getUint16(e, true);
        const len = v.getUint16(e + 2, true);
        if (id === 0x0001) {
          let p = e + 4;
          if (size === 0xffffffff) { size = u64(v, p); p += 8; }
          if (compressedSize === 0xffffffff) { compressedSize = u64(v, p); p += 8; }
          if (localHeaderOffset === 0xffffffff) { localHeaderOffset = u64(v, p); }
          break;
        }
        e += 4 + len;
      }
    }

    if (!name.endsWith('/')) entries.push({ name, method, compressedSize, size, localHeaderOffset });
    pos += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/**
 * Offset of an entry's data. The local header's extra field can differ from
 * the central one (zipalign pads it), so it has to be read.
 */
export async function entryDataOffset(zip: Blob, entry: ZipEntry): Promise<number> {
  const h = await readRange(zip, entry.localHeaderOffset, entry.localHeaderOffset + 30);
  const v = new DataView(h.buffer, h.byteOffset, h.byteLength);
  if (h.length < 30 || v.getUint32(0, true) !== LOCAL_SIG) throw new ZipError(`Bad local header for ${entry.name}`);
  return entry.localHeaderOffset + 30 + v.getUint16(26, true) + v.getUint16(28, true);
}

/** Reads (and inflates if needed) one entry. Use for small files only. */
export async function readZipEntry(zip: Blob, entry: ZipEntry, dataOffset?: number): Promise<Uint8Array> {
  const start = dataOffset ?? (await entryDataOffset(zip, entry));
  const raw = await readRange(zip, start, start + entry.compressedSize);
  if (entry.method === 0) return raw;
  if (entry.method === 8) {
    try {
      return inflateRaw(raw);
    } catch (e) {
      throw new ZipError(`Could not inflate ${entry.name}: ${(e as Error)?.message ?? e}`);
    }
  }
  throw new ZipError(`Unsupported compression method ${entry.method} for ${entry.name}`);
}

/**
 * Maps an APK entry to its path inside the Ren'Py game directory, or null.
 *   main APK: assets/x-game/x-images/x-bg.png → images/bg.png
 *   pack APK: assets/game/images/bg.png       → images/bg.png
 */
export function apkGamePath(name: string): string | null {
  if (name.startsWith('assets/x-game/')) {
    const parts = name.slice('assets/x-game/'.length).split('/');
    if (!parts.every((p) => p.startsWith('x-'))) return null;
    return parts.map((p) => p.slice(2)).join('/');
  }
  if (name.startsWith('assets/game/')) return name.slice('assets/game/'.length);
  return null;
}
