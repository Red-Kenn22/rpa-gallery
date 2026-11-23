/**
 * Ren'Py archive (.rpa) index reader.
 *
 * Reads only two small byte ranges from the archive — the header line and the
 * zlib-compressed index at the end — via `Blob.slice()`, so a multi-GB archive
 * never has to fit in memory. Works on `File` objects from a plain
 * `<input type="file">` and inside a Web Worker.
 *
 * Supported layouts
 *   RPA-3.0  "RPA-3.0 <16 hex offset> <8 hex key>\n"   (Ren'Py 6.18+ / 7 / 8)
 *   RPA-3.2  "RPA-3.2 <offset> <ignored> <key…>\n"     (third-party variant)
 *   RPA-2.0  "RPA-2.0 <16 hex offset>\n"                (no XOR key)
 *   ALT-1.0  "ALT-1.0 <key> <offset>\n"                 (key ^ 0xDABE8DF0)
 *   RPA-1.0  headerless data file + separate zlib .rpi index → parseRpiIndex()
 *
 * Index format (after zlib inflate + unpickle):
 *   { "path/in/archive.png": [ (offset ^ key, length ^ key[, prefix]) , … ] }
 * `length` counts the prefix bytes; the archive holds `length - prefix.length`
 * bytes starting at `offset`. Almost every entry has exactly one segment.
 */

import { inflate } from 'pako';
import { latin1Encode, unpickle } from './pickle';

// ─── Types ──────────────────────────────────────────────────────────────────

export type RpaVersion = 'RPA-3.0' | 'RPA-3.2' | 'RPA-2.0' | 'ALT-1.0' | 'RPA-1.0';

export interface RpaSegment {
  /** Byte offset of the stored data inside the archive (after the prefix). */
  offset: number;
  /** Logical file length, including `prefix`. */
  length: number;
  /** Bytes that logically precede the stored data. Usually absent. */
  prefix?: Uint8Array;
}

export interface RpaEntry extends RpaSegment {
  /**
   * Present only for the rare multi-segment entries from very old archives.
   * The top-level offset/length/prefix then mirror `segments[0]`, and the file
   * is the concatenation of every segment.
   */
  segments?: RpaSegment[];
}

/** Archive path → entry. Created with a null prototype (safe for any path). */
export type RpaIndex = Record<string, RpaEntry>;

export interface RpaHeader {
  version: RpaVersion;
  /** Byte offset of the compressed index. */
  indexOffset: number;
  /** XOR key for offsets/lengths, or null when the format has none. */
  key: bigint | null;
  /** Length of the header line including the newline. */
  headerLength: number;
}

export interface RpaArchive extends RpaHeader {
  index: RpaIndex;
  fileCount: number;
  /** Total logical bytes across all entries. */
  totalBytes: number;
  /** Entries skipped because they point outside the archive. */
  skipped: string[];
}

export class RpaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RpaError';
  }
}

// ─── Byte-range reads ───────────────────────────────────────────────────────

/** Reads `[start, end)` of a Blob without touching the rest of it. */
export async function readRange(blob: Blob, start: number, end: number): Promise<Uint8Array> {
  const part = blob.slice(start, end);
  if (typeof part.arrayBuffer === 'function') {
    return new Uint8Array(await part.arrayBuffer());
  }
  // Older WebKit without Blob.arrayBuffer()
  return new Promise<Uint8Array>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'));
    reader.readAsArrayBuffer(part);
  });
}

// ─── Header ─────────────────────────────────────────────────────────────────

const HEADER_PROBE = 256;
const ALT_KEY_MASK = 0xdabe8df0n;

function parseHex(token: string | undefined, what: string): bigint {
  if (!token || !/^[0-9a-fA-F]+$/.test(token)) {
    throw new RpaError(`Malformed archive header: bad ${what} ${JSON.stringify(token ?? '')}`);
  }
  return BigInt(`0x${token}`);
}

function xorAll(tokens: string[], what: string): bigint {
  if (tokens.length === 0) throw new RpaError(`Malformed archive header: missing ${what}`);
  return tokens.reduce((acc, t) => acc ^ parseHex(t, what), 0n);
}

function toOffset(v: bigint, size: number): number {
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n <= 0 || n >= size) {
    throw new RpaError(`Index offset 0x${v.toString(16)} lies outside the ${size}-byte file`);
  }
  return n;
}

/** Parses the first line of an archive. Throws RpaError for unknown formats. */
export async function parseRpaHeader(archive: Blob): Promise<RpaHeader> {
  if (archive.size < 8) throw new RpaError('File is too small to be a Ren\'Py archive');

  const probe = await readRange(archive, 0, Math.min(HEADER_PROBE, archive.size));
  const nl = probe.indexOf(0x0a);
  const lineBytes = nl >= 0 ? probe.subarray(0, nl) : probe;
  const line = String.fromCharCode(...lineBytes).trim();
  const parts = line.split(/\s+/);
  const magic = parts[0] ?? '';
  const headerLength = nl >= 0 ? nl + 1 : probe.length;

  switch (magic) {
    case 'RPA-3.0':
      return {
        version: 'RPA-3.0',
        indexOffset: toOffset(parseHex(parts[1], 'offset'), archive.size),
        key: xorAll(parts.slice(2), 'key'),
        headerLength,
      };
    case 'RPA-3.2':
      return {
        version: 'RPA-3.2',
        indexOffset: toOffset(parseHex(parts[1], 'offset'), archive.size),
        key: xorAll(parts.slice(3), 'key'),
        headerLength,
      };
    case 'RPA-2.0':
      return {
        version: 'RPA-2.0',
        indexOffset: toOffset(parseHex(parts[1], 'offset'), archive.size),
        key: null,
        headerLength,
      };
    case 'ALT-1.0':
      return {
        version: 'ALT-1.0',
        indexOffset: toOffset(parseHex(parts[2], 'offset'), archive.size),
        key: parseHex(parts[1], 'key') ^ ALT_KEY_MASK,
        headerLength,
      };
  }

  if (magic.startsWith('ZiX-12')) {
    throw new RpaError(`${magic} archives use a custom obfuscation layer and are not supported`);
  }
  if (magic.startsWith('RPA-')) {
    throw new RpaError(`Unsupported archive version ${magic}`);
  }
  throw new RpaError(
    "Not a Ren'Py archive. If this is an RPA-1.0 data file, open its matching .rpi index instead.",
  );
}

// ─── Index decoding ─────────────────────────────────────────────────────────

const textDecoder = new TextDecoder('utf-8');

function normalizeName(key: unknown): string | null {
  if (typeof key === 'string') return key;
  if (key instanceof Uint8Array) return textDecoder.decode(key);
  return null;
}

function normalizePrefix(v: unknown): Uint8Array | undefined {
  if (v == null) return undefined;
  if (v instanceof Uint8Array) return v.length ? v : undefined;
  if (typeof v === 'string') return v.length ? latin1Encode(v) : undefined;
  return undefined;
}

function deobfuscate(v: unknown, key: bigint | null): number {
  if (typeof v !== 'number' && typeof v !== 'bigint') return NaN;
  if (key === null) return Number(v);
  // Python ints are arbitrary precision; JS `^` is 32-bit, so use BigInt.
  return Number(BigInt(v) ^ key);
}

function decodeSegments(raw: unknown, key: bigint | null): RpaSegment[] | null {
  if (!Array.isArray(raw)) return null;
  // A bare (offset, length[, prefix]) tuple instead of a list of them.
  const tuples = raw.length > 0 && !Array.isArray(raw[0]) ? [raw] : raw;
  const out: RpaSegment[] = [];
  for (const t of tuples) {
    if (!Array.isArray(t) || t.length < 2) return null;
    const offset = deobfuscate(t[0], key);
    const length = deobfuscate(t[1], key);
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length)) return null;
    const prefix = normalizePrefix(t[2]);
    out.push(prefix ? { offset, length, prefix } : { offset, length });
  }
  return out.length ? out : null;
}

function segmentInBounds(s: RpaSegment, size: number): boolean {
  const stored = s.length - (s.prefix?.length ?? 0);
  return s.offset >= 0 && stored >= 0 && s.offset + stored <= size;
}

/**
 * Turns an unpickled index dict into a clean RpaIndex.
 * Exported so the worker can reuse it for cached raw indexes.
 */
export function buildIndex(
  raw: unknown,
  key: bigint | null,
  archiveSize: number,
): { index: RpaIndex; totalBytes: number; skipped: string[] } {
  if (!(raw instanceof Map)) throw new RpaError('Archive index is not a dictionary');

  const index: RpaIndex = Object.create(null);
  const skipped: string[] = [];
  let totalBytes = 0;

  for (const [rawName, rawValue] of raw) {
    const name = normalizeName(rawName);
    if (name === null) continue;
    const segments = decodeSegments(rawValue, key);
    if (!segments || !segments.every((s) => segmentInBounds(s, archiveSize))) {
      skipped.push(name);
      continue;
    }
    const first = segments[0];
    const entry: RpaEntry = { ...first };
    if (segments.length > 1) {
      entry.segments = segments;
      entry.length = segments.reduce((n, s) => n + s.length, 0);
    }
    index[name.replace(/\\/g, '/')] = entry;
    totalBytes += entry.length;
  }

  const total = raw.size;
  if (total > 0 && skipped.length > total / 2) {
    throw new RpaError(
      `${skipped.length} of ${total} entries point outside the archive — the XOR key or format variant is probably wrong`,
    );
  }
  return { index, totalBytes, skipped };
}

function inflateIndex(compressed: Uint8Array): Uint8Array {
  try {
    return inflate(compressed);
  } catch (e) {
    throw new RpaError(`Could not decompress the archive index: ${(e as Error)?.message ?? e}`);
  }
}

function unpickleIndex(bytes: Uint8Array): unknown {
  try {
    // Keep Python 2 `str` as raw bytes so prefixes survive byte-for-byte;
    // buildIndex() decodes names as UTF-8 itself.
    return unpickle(bytes, { encoding: 'bytes' });
  } catch (e) {
    throw new RpaError(`Could not read the archive index: ${(e as Error)?.message ?? e}`);
  }
}

/**
 * Parses an RPA-2.0 / 3.0 / 3.2 / ALT-1.0 archive's index.
 * Reads only the header and the index bytes, never the stored files.
 */
export async function parseRpaIndex(archive: Blob): Promise<RpaArchive> {
  const header = await parseRpaHeader(archive);
  const compressed = await readRange(archive, header.indexOffset, archive.size);
  const raw = unpickleIndex(inflateIndex(compressed));
  const { index, totalBytes, skipped } = buildIndex(raw, header.key, archive.size);
  return { ...header, index, fileCount: Object.keys(index).length, totalBytes, skipped };
}

/**
 * RPA-1.0: the `.rpi` file is a zlib-compressed pickle with plain offsets;
 * the matching `.rpa` holds the data and has no header.
 */
export async function parseRpiIndex(rpi: Blob, dataArchive: Blob): Promise<RpaArchive> {
  const compressed = await readRange(rpi, 0, rpi.size);
  const raw = unpickleIndex(inflateIndex(compressed));
  const { index, totalBytes, skipped } = buildIndex(raw, null, dataArchive.size);
  return {
    version: 'RPA-1.0',
    indexOffset: 0,
    key: null,
    headerLength: 0,
    index,
    fileCount: Object.keys(index).length,
    totalBytes,
    skipped,
  };
}

// ─── Entry access (lazy, slice-based) ───────────────────────────────────────

const MIME_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  avif: 'image/avif',
  gif: 'image/gif',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  webm: 'video/webm',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mkv: 'video/x-matroska',
  ogv: 'video/ogg',
  avi: 'video/x-msvideo',
  mpg: 'video/mpeg',
  mpeg: 'video/mpeg',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  flac: 'audio/flac',
  ttf: 'font/ttf',
  otf: 'font/otf',
  txt: 'text/plain',
  json: 'application/json',
};

export function extensionOf(path: string): string {
  const dot = path.lastIndexOf('.');
  const slash = path.lastIndexOf('/');
  return dot > slash ? path.slice(dot + 1).toLowerCase() : '';
}

export function guessMimeType(path: string): string {
  return MIME_TYPES[extensionOf(path)] ?? 'application/octet-stream';
}

/**
 * A lazy Blob for one archived file. Nothing is read until the Blob is
 * consumed, so `URL.createObjectURL(entryBlob(...))` streams straight from the
 * user's file — safe for large videos on mobile.
 */
export function entryBlob(archive: Blob, entry: RpaEntry, type = ''): Blob {
  const parts: BlobPart[] = [];
  for (const s of entry.segments ?? [entry]) {
    const prefixLen = s.prefix?.length ?? 0;
    if (s.prefix) parts.push(s.prefix as Uint8Array<ArrayBuffer>);
    parts.push(archive.slice(s.offset, s.offset + s.length - prefixLen));
  }
  return new Blob(parts, { type });
}

/** Reads one archived file fully into memory. Use only for small files (.rpyc, .rpy). */
export async function readEntry(archive: Blob, entry: RpaEntry): Promise<Uint8Array> {
  const segs = entry.segments ?? [entry];
  if (segs.length === 1 && !segs[0].prefix) {
    return readRange(archive, entry.offset, entry.offset + entry.length);
  }
  const out = new Uint8Array(entry.length);
  let pos = 0;
  for (const s of segs) {
    if (s.prefix) {
      out.set(s.prefix, pos);
      pos += s.prefix.length;
    }
    const stored = s.length - (s.prefix?.length ?? 0);
    out.set(await readRange(archive, s.offset, s.offset + stored), pos);
    pos += stored;
  }
  return out;
}
