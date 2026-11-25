/**
 * The full indexing pipeline, independent of Web Worker plumbing:
 *
 *   files ─► archive indexes ─► asset table ─► .rpyc/.rpy scripts ─► scenes
 *
 * Accepts any mix of .rpa archives (games often split scripts.rpa /
 * images.rpa), RPA-1.0 .rpa+.rpi pairs, and loose .rpyc/.rpy files.
 * Every read is a byte-range slice; only script files are loaded whole, one at
 * a time, and their ASTs are discarded as soon as they've been converted.
 */

import type { AssetRef, GalleryIndex, IndexDiagnostics, IndexProgress, ScenePrograms, SourceInfo } from '../types';
import { AstWalker } from './astWalker';
import { cacheKeyFor } from './cacheKey';
import { buildFolderGallery } from './folderGallery';
import { decodeRpyc } from './rpyc';
import { parseRpy } from './rpyParser';
import { DiagCollector } from './diagScan';
import { buildScenes, mediaKind, type AssetLookup } from './sceneParser';
import type { ScriptFile } from './scriptModel';
import {
  extensionOf,
  guessMimeType,
  parseRpaIndex,
  parseRpiIndex,
  readEntry,
  RpaError,
  type RpaArchive,
  type RpaEntry,
} from './rpaParser';
import { apkGamePath, entryDataOffset, readZipDirectory, readZipEntry, type ZipEntry } from './zipReader';

export interface SourceFile {
  name: string;
  size: number;
  lastModified: number;
  blob: Blob;
}

export function sourceFromFile(f: File): SourceFile {
  return { name: f.name, size: f.size, lastModified: f.lastModified, blob: f };
}

export { cacheKeyFor };

export class IndexCancelledError extends Error {
  constructor() {
    super('Indexing was cancelled');
    this.name = 'IndexCancelledError';
  }
}

export interface IndexerHooks {
  onProgress?: (p: IndexProgress) => void;
  /** Checked between files; set `cancelled = true` to stop. */
  signal?: { cancelled: boolean };
}

interface AssetSlot {
  source: number;
  path: string;
  /** For zip (APK) entries `entry.offset` is resolved lazily from `zip`. */
  entry: RpaEntry;
  zip?: ZipEntry;
}

export interface IndexResult {
  index: GalleryIndex;
  /** Compiled labels for the scene player (null in folder mode). */
  programs: ScenePrograms | null;
}

const COMPILED_EXT = new Set(['rpyc', 'rpymc']);
const SOURCE_EXT = new Set(['rpy', 'rpym']);
const MAX_WARNINGS = 60;

const stem = (name: string) => name.replace(/\.[^./]+$/, '').toLowerCase();
const baseName = (p: string) => p.slice(p.lastIndexOf('/') + 1);

function isSkippedScript(lowerPath: string): boolean {
  // Translations duplicate every line; engine copies aren't game content.
  return /^(?:tl|renpy|common)\//.test(lowerPath) || lowerPath.includes('/tl/');
}

class AssetTable implements AssetLookup {
  readonly byLower = new Map<string, AssetSlot>();
  private byBase: Map<string, AssetSlot[]> | null = null;

  add(slot: AssetSlot): void {
    const key = slot.path.toLowerCase();
    if (!this.byLower.has(key)) this.byLower.set(key, slot);
  }

  get(path: string): AssetSlot | undefined {
    return this.byLower.get(path.toLowerCase());
  }

  resolve(path: string): string | null {
    const norm = path.replace(/\\/g, '/').replace(/^\.?\//, '').replace(/^game\//i, '').toLowerCase();
    const hit = this.byLower.get(norm) ?? this.byLower.get(`images/${norm}`);
    if (hit) return hit.path;
    // Last resort: a unique basename match anywhere in the archives.
    if (!this.byBase) {
      this.byBase = new Map();
      for (const slot of this.byLower.values()) {
        const b = baseName(slot.path).toLowerCase();
        const list = this.byBase.get(b) ?? [];
        list.push(slot);
        this.byBase.set(b, list);
      }
    }
    const cands = this.byBase.get(baseName(norm));
    return cands && cands.length === 1 ? cands[0].path : null;
  }

  *paths(): Iterable<string> {
    for (const slot of this.byLower.values()) yield slot.path;
  }
}

const MAX_DIAG_FOLDERS = 600;
const MAX_DIAG_SCRIPTS = 2000;

/** Per-folder file counts for the diagnostics report (largest folders kept if there are many). */
function folderSummary(paths: Iterable<string>): Pick<IndexDiagnostics, 'folders' | 'foldersTruncated'> {
  const byDir = new Map<string, IndexDiagnostics['folders'][number]>();
  for (const p of paths) {
    const cut = p.lastIndexOf('/');
    const dir = cut < 0 ? '' : p.slice(0, cut);
    let f = byDir.get(dir);
    if (!f) byDir.set(dir, (f = { dir, images: 0, videos: 0, audio: 0, scripts: 0, other: 0, samples: [] }));
    const ext = extensionOf(p);
    const k = mediaKind(p);
    if (k === 'image') f.images++;
    else if (k === 'video') f.videos++;
    else if (k === 'audio') f.audio++;
    else if (COMPILED_EXT.has(ext) || SOURCE_EXT.has(ext)) f.scripts++;
    else f.other++;
    if (f.samples.length < 4) f.samples.push(p.slice(cut + 1));
  }
  let folders = [...byDir.values()];
  const foldersTruncated = folders.length > MAX_DIAG_FOLDERS;
  if (foldersTruncated) {
    const total = (f: (typeof folders)[number]) => f.images + f.videos + f.audio + f.scripts + f.other;
    folders = folders.sort((a, b) => total(b) - total(a)).slice(0, MAX_DIAG_FOLDERS);
  }
  folders.sort((a, b) => a.dir.localeCompare(b.dir));
  return { folders, foldersTruncated };
}

export async function buildGalleryIndex(files: SourceFile[], hooks: IndexerHooks = {}): Promise<IndexResult> {
  const t0 = Date.now();
  const warnings: string[] = [];
  const warn = (msg: string) => {
    if (warnings.length < MAX_WARNINGS) warnings.push(msg);
  };
  const progress = (p: IndexProgress) => hooks.onProgress?.(p);
  const checkCancelled = () => {
    if (hooks.signal?.cancelled) throw new IndexCancelledError();
  };

  const sources: SourceInfo[] = files.map((f) => ({
    name: f.name,
    size: f.size,
    lastModified: f.lastModified,
    kind: 'loose',
    entries: 1,
  }));
  const table = new AssetTable();

  // ── 1. Archive indexes ──
  const archiveIdx = files.map((f, i) => ({ f, i })).filter(({ f }) => extensionOf(f.name) === 'rpa');
  const rpiIdx = new Map(
    files.map((f, i) => ({ f, i })).filter(({ f }) => extensionOf(f.name) === 'rpi').map((x) => [stem(x.f.name), x]),
  );
  const parsed: { i: number; archive: RpaArchive }[] = [];
  let archiveEntries = 0;

  // Loose files win over archives, as in Ren'Py.
  files.forEach((f, i) => {
    const ext = extensionOf(f.name);
    if (ext === 'rpa' || ext === 'rpi' || ext === 'apk') return;
    sources[i].kind = COMPILED_EXT.has(ext) || SOURCE_EXT.has(ext) ? 'script' : 'loose';
    table.add({ source: i, path: f.name, entry: { offset: 0, length: f.size } });
  });

  for (let n = 0; n < archiveIdx.length; n++) {
    checkCancelled();
    const { f, i } = archiveIdx[n];
    progress({ phase: 'reading-index', done: n, total: archiveIdx.length, current: f.name });
    try {
      let archive: RpaArchive;
      try {
        archive = await parseRpaIndex(f.blob);
      } catch (e) {
        const rpi = rpiIdx.get(stem(f.name));
        if (!(e instanceof RpaError) || !rpi) throw e;
        archive = await parseRpiIndex(rpi.f.blob, f.blob);
        sources[rpi.i].kind = 'rpi';
        sources[rpi.i].entries = archive.fileCount;
      }
      sources[i].kind = 'rpa';
      sources[i].version = archive.version;
      sources[i].entries = archive.fileCount;
      if (archive.skipped.length) warn(`${f.name}: skipped ${archive.skipped.length} damaged entries`);
      parsed.push({ i, archive });
    } catch (e) {
      sources[i].kind = 'rpa';
      sources[i].entries = 0;
      warn(`${f.name}: ${(e as Error).message ?? e}`);
    }
  }
  for (const [, { i }] of rpiIdx) if (sources[i].kind === 'loose') sources[i].kind = 'rpi';

  // Ren'Py loads archives in name order; the first one to provide a path wins.
  parsed.sort((a, b) => files[a.i].name.localeCompare(files[b.i].name));
  for (const { i, archive } of parsed) {
    for (const path in archive.index) {
      table.add({ source: i, path, entry: archive.index[path] });
      archiveEntries++;
    }
  }

  // ── APKs: Ren'Py keeps game files under assets/x-game/ (x- on every component) ──
  const apks = files.map((f, i) => ({ f, i })).filter(({ f }) => extensionOf(f.name) === 'apk');
  for (const { f, i } of apks) {
    checkCancelled();
    progress({ phase: 'reading-index', done: archiveIdx.length, total: archiveIdx.length + apks.length, current: f.name });
    sources[i].kind = 'apk';
    try {
      const entries = await readZipDirectory(f.blob);
      let count = 0;
      const nested: { path: string; zip: ZipEntry }[] = [];
      for (const z of entries) {
        const path = apkGamePath(z.name);
        if (!path) continue;
        if (extensionOf(path) === 'rpa') nested.push({ path, zip: z });
        else {
          table.add({ source: i, path, entry: { offset: -1, length: z.size }, zip: z });
          count++;
        }
      }
      // Archives packed inside the APK: readable in place when stored uncompressed.
      for (const { path, zip } of nested.sort((a, b) => a.path.localeCompare(b.path))) {
        if (zip.method !== 0) {
          warn(`${f.name}: ${path} is compressed inside the APK and can't be read in place`);
          continue;
        }
        try {
          const base = await entryDataOffset(f.blob, zip);
          const inner = await parseRpaIndex(f.blob.slice(base, base + zip.size));
          for (const p in inner.index) {
            const e = inner.index[p];
            const shift = (s: RpaEntry): RpaEntry => ({ ...s, offset: s.offset + base });
            const moved: RpaEntry = shift(e);
            if (e.segments) moved.segments = e.segments.map(shift);
            table.add({ source: i, path: p, entry: moved });
            count++;
          }
        } catch (e) {
          warn(`${f.name}: ${path}: ${(e as Error).message ?? e}`);
        }
      }
      sources[i].entries = count;
      archiveEntries += count;
      if (!count) warn(`${f.name}: no Ren'Py game files found inside this APK`);
    } catch (e) {
      sources[i].entries = 0;
      warn(`${f.name}: ${(e as Error).message ?? e}`);
    }
  }
  progress({ phase: 'reading-index', done: archiveIdx.length + apks.length, total: archiveIdx.length + apks.length });

  // ── 2. Pick scripts: compiled first, sources as fallback ──
  const compiled = new Map<string, AssetSlot>();
  const plain = new Map<string, AssetSlot>();
  for (const [lower, slot] of table.byLower) {
    if (isSkippedScript(lower)) continue;
    const ext = extensionOf(lower);
    if (COMPILED_EXT.has(ext)) compiled.set(stem(lower), slot);
    else if (SOURCE_EXT.has(ext)) plain.set(stem(lower), slot);
  }
  const jobs: { slot: AssetSlot; fallback?: AssetSlot }[] = [];
  for (const [s, slot] of compiled) jobs.push({ slot, fallback: plain.get(s) });
  for (const [s, slot] of plain) if (!compiled.has(s)) jobs.push({ slot });
  jobs.sort((a, b) => a.slot.path.localeCompare(b.slot.path));

  // ── 3. Parse scripts one at a time ──
  const scripts: ScriptFile[] = [];
  const unknown = new Set<string>();
  const textDecoder = new TextDecoder('utf-8');
  let scriptsFailed = 0;
  const diag = new DiagCollector();
  const scriptDiag: IndexDiagnostics['scripts'] = [];
  const errText = (e: unknown) => String((e as Error)?.message ?? e).slice(0, 200);

  const parseOne = async (slot: AssetSlot): Promise<ScriptFile> => {
    const blob = files[slot.source].blob;
    const bytes = slot.zip ? await readZipEntry(blob, slot.zip) : await readEntry(blob, slot.entry);
    if (COMPILED_EXT.has(extensionOf(slot.path))) {
      const rpyc = decodeRpyc(bytes);
      const walker = new AstWalker();
      const stmts = walker.walk(rpyc.stmts);
      for (const c of walker.unknownClasses) unknown.add(c);
      try {
        diag.scanTree(slot.path, rpyc.stmts);
      } catch {
        /* diagnostics are best effort */
      }
      return { path: slot.path, stmts };
    }
    const text = textDecoder.decode(bytes);
    try {
      diag.scanText(slot.path, text);
    } catch {
      /* diagnostics are best effort */
    }
    return { path: slot.path, stmts: parseRpy(text) };
  };

  for (let n = 0; n < jobs.length; n++) {
    checkCancelled();
    const { slot, fallback } = jobs[n];
    progress({ phase: 'parsing-scripts', done: n, total: jobs.length, current: slot.path });
    try {
      const sf = await parseOne(slot);
      scripts.push(sf);
      scriptDiag.push({ path: slot.path, how: COMPILED_EXT.has(extensionOf(slot.path)) ? 'rpyc' : 'rpy', stmts: sf.stmts.length });
    } catch (e) {
      if (fallback) {
        try {
          const sf = await parseOne(fallback);
          scripts.push(sf);
          scriptDiag.push({ path: fallback.path, how: 'fallback', stmts: sf.stmts.length, error: errText(e) });
          warn(`${slot.path}: unreadable (${(e as Error).message ?? e}); used ${fallback.path} instead`);
          continue;
        } catch {
          /* fall through */
        }
      }
      scriptsFailed++;
      scriptDiag.push({ path: slot.path, how: 'failed', stmts: 0, error: errText(e) });
      warn(`${slot.path}: ${(e as Error).message ?? e}`);
    }
  }
  progress({ phase: 'parsing-scripts', done: jobs.length, total: jobs.length });

  if (unknown.size) warn(`Unrecognised AST node types (ignored): ${[...unknown].slice(0, 12).join(', ')}`);

  // ── 4. Scenes & characters ──
  checkCancelled();
  progress({ phase: 'building', done: 0, total: 1 });
  const counts = { images: 0, videos: 0, audio: 0 };
  for (const p of table.paths()) {
    const k = mediaKind(p);
    if (k === 'image') counts.images++;
    else if (k === 'video') counts.videos++;
    else if (k === 'audio') counts.audio++;
  }

  const built = buildScenes(scripts, table);
  let result: { characters: GalleryIndex['characters']; scenes: GalleryIndex['scenes']; labels: number; referenced: Set<string> } = built;
  let programs: ScenePrograms | null = built.programs;
  let mode: GalleryIndex['mode'] = 'scripts';
  if (!result.scenes.length) {
    // No usable scripts: fall back to browsing the archive by folder.
    const folders = buildFolderGallery(table.paths());
    if (folders.scenes.length) {
      mode = 'folders';
      programs = null;
      result = { ...folders, labels: result.labels };
    }
  }

  const assets: Record<string, AssetRef> = Object.create(null);
  for (const path of result.referenced) {
    const slot = table.get(path);
    if (!slot) continue;
    const { entry } = slot;
    const ref: AssetRef = {
      source: slot.source,
      path: slot.path,
      offset: entry.offset,
      length: entry.length,
      mime: guessMimeType(slot.path),
      kind: mediaKind(slot.path),
    };
    if (slot.zip) {
      try {
        ref.offset = await entryDataOffset(files[slot.source].blob, slot.zip);
      } catch (e) {
        warn(`${slot.path}: ${(e as Error).message ?? e}`);
        continue;
      }
      if (slot.zip.method === 8) ref.deflated = { compressedLength: slot.zip.compressedSize };
      else if (slot.zip.method !== 0) continue;
    }
    if (entry.prefix) ref.prefix = entry.prefix;
    if (entry.segments) ref.segments = entry.segments;
    assets[path] = ref;
  }
  progress({ phase: 'building', done: 1, total: 1 });

  const index: GalleryIndex = {
    schema: 6,
    mode,
    key: cacheKeyFor(files),
    sources,
    characters: result.characters,
    scenes: result.scenes,
    assets,
    stats: {
      scriptsFound: jobs.length,
      scriptsParsed: scripts.length,
      scriptsFailed,
      labels: result.labels,
      scenes: result.scenes.length,
      archiveEntries,
      ...counts,
      millis: Date.now() - t0,
    },
    warnings,
    diag: {
      ...folderSummary(table.paths()),
      scripts: scriptDiag.slice(0, MAX_DIAG_SCRIPTS),
      screens: diag.screens,
      replay: diag.replay,
      code: diag.code,
    },
  };
  return { index, programs };
}
