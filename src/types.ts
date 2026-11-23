/**
 * Shapes shared by the worker, the IndexedDB cache and the UI.
 * Everything here is structured-clone safe (no class instances).
 */

import type { RpaSegment } from './lib/rpaParser';

export type MediaKind = 'image' | 'video' | 'audio' | 'other';

export interface CharacterInfo {
  /** Script variable (e.g. "e") or `name:<Display Name>` for literal speakers. */
  id: string;
  name: string;
  color?: string;
  sceneCount: number;
  lineCount: number;
}

export interface DialogueLine {
  /** Character id, or null for narration. */
  who: string | null;
  what: string;
  /** Menu choice rather than spoken text. */
  choice?: true;
}

export interface SceneInfo {
  /** Label name, e.g. "chapter1.beach". */
  id: string;
  title: string;
  /** Script file the label came from. */
  file: string;
  line: number;
  /** Speakers first (most lines first), then characters who only appear. */
  characters: string[];
  speakers: string[];
  /** Archive paths of `scene` backgrounds, in order. */
  backgrounds: string[];
  /** All still images used (backgrounds + non-character `show`s). */
  images: string[];
  /** Archive paths of video cutscenes / Movie images. */
  videos: string[];
  thumbnail: { path: string; kind: 'image' | 'video' } | null;
  /** Up to DIALOGUE_CAP lines; `dialogueCount` is the full total. */
  dialogue: DialogueLine[];
  dialogueCount: number;
}

/** Where to find one archived file. `source` indexes GalleryIndex.sources. */
export interface AssetRef extends RpaSegment {
  source: number;
  path: string;
  mime: string;
  kind: MediaKind;
  segments?: RpaSegment[];
}

export type SourceKind = 'rpa' | 'rpi' | 'script' | 'loose';

export interface SourceInfo {
  name: string;
  size: number;
  lastModified: number;
  kind: SourceKind;
  /** Archive format, e.g. "RPA-3.0". */
  version?: string;
  entries: number;
}

export interface IndexStats {
  /** Script files found in the selection (.rpyc/.rpy, excluding translations). */
  scriptsFound: number;
  scriptsParsed: number;
  scriptsFailed: number;
  labels: number;
  scenes: number;
  archiveEntries: number;
  images: number;
  videos: number;
  audio: number;
  millis: number;
}

export interface GalleryIndex {
  schema: 2;
  /**
   * 'scripts' – scenes come from the game's labels.
   * 'folders' – no scripts were found; scenes are the archive's folders and
   *             `characters` are its top-level folders.
   */
  mode: 'scripts' | 'folders';
  /** Cache key: `${name}_${size}_${lastModified}` per source, sorted, joined by "|". */
  key: string;
  sources: SourceInfo[];
  characters: CharacterInfo[];
  scenes: SceneInfo[];
  /** Only assets referenced by scenes, keyed by archive path. */
  assets: Record<string, AssetRef>;
  stats: IndexStats;
  warnings: string[];
}

export type IndexPhase = 'reading-index' | 'parsing-scripts' | 'building';

export interface IndexProgress {
  phase: IndexPhase;
  done: number;
  total: number;
  /** File currently being processed. */
  current?: string;
}
