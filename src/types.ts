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
  /** Best guess at a picture of this character (archive path), if any. */
  portrait?: string;
  /** Other plausible portraits, best first (for the "Change portrait" picker). */
  portraitCandidates?: string[];
}

export interface DialogueLine {
  /** Character id, or null for narration. */
  who: string | null;
  what: string;
  /** Menu choice rather than spoken text. */
  choice?: true;
}

export interface SceneInfo {
  /** Entry label name, e.g. "chapter1.beach". */
  id: string;
  /** Labels merged into this scene (entry first): continuations, menu branches, local labels. */
  labels: string[];
  /** Estimated play time along a typical path through the scene, in seconds. */
  durationSec: number;
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
  /** Deflate-compressed inside an APK: `offset` points at compressed data of this length. */
  deflated?: { compressedLength: number };
}

export type SourceKind = 'rpa' | 'rpi' | 'apk' | 'script' | 'loose';

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

/** Facts gathered while indexing, for the "Export diagnostics" report. */
export interface IndexDiagnostics {
  /** Every folder in the selection with file counts by kind and a few sample names. */
  folders: { dir: string; images: number; videos: number; audio: number; scripts: number; other: number; samples: string[] }[];
  /** True when `folders` was cut down to the largest folders. */
  foldersTruncated: boolean;
  scripts: { path: string; how: 'rpyc' | 'rpy' | 'fallback' | 'failed'; stmts: number; error?: string }[];
  /** Screens defined in the scripts. */
  screens: { name: string; file: string }[];
  /** Script lines mentioning Replay(...), call_replay or Gallery code (for a replay-gallery view). */
  replay: { file: string; screen?: string; text: string }[];
}

export interface GalleryIndex {
  schema: 5;
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
  diag?: IndexDiagnostics;
}

export type IndexPhase = 'reading-index' | 'parsing-scripts' | 'building';

export interface IndexProgress {
  phase: IndexPhase;
  done: number;
  total: number;
  /** File currently being processed. */
  current?: string;
}

// ─── Scene player programs ───────────────────────────────────────────────────

/** Image alignment on the stage: [xalign, yalign] (Ren'Py's default is [0.5, 1]). */
export type StagePos = [number, number];

/**
 * One instruction of a compiled label. Image paths are resolved archive paths
 * (null when the script names an image we couldn't find; `name` is kept for display).
 */
export type Step =
  /** `scene`: clears all layers; a video path loops like a Movie displayable. */
  | { t: 'bg'; img: string | null; name: string | null; tag: string | null }
  | { t: 'show'; tag: string; img: string | null; name: string; pos: StagePos | null }
  | { t: 'hide'; tag: string }
  | { t: 'say'; who: string | null; what: string; extend?: true }
  | { t: 'pause' }
  /** Cutscene: plays once full screen, then continues. */
  | { t: 'video'; img: string | null; name: string }
  /** `exit` = first step after the whole menu (where choices that don't jump rejoin). */
  | { t: 'menu'; choices: { text: string; cond: string | null; to: number; info?: ChoiceInfo }[]; exit: number }
  /** `if`/`elif`/`else`: the player asks which branch to take (or takes the first). */
  | { t: 'branch'; options: { cond: string; to: number; info?: ChoiceInfo }[]; exit: number }
  /** Audio on a channel (music, sound, voice, or a custom one). `loop` null = channel default. */
  | { t: 'audio'; ch: string; op: 'play' | 'queue' | 'stop'; files: string[]; loop: boolean | null; fade: number }
  /** Variable changes from Python (`$ lucy_love += 1`); no-op for the player, used for choice details. */
  | { t: 'set'; changes: VarChange[] }
  | { t: 'goto'; to: number }
  | { t: 'jump'; label: string }
  | { t: 'call'; label: string }
  | { t: 'return' };

/** `op: 'call'` records a game function call such as `add_points("lucy", 2)` in `val`. */
export interface VarChange {
  v: string;
  op: '+=' | '-=' | '=' | 'call';
  val: string;
}

/** What a menu choice (or if-branch) leads to, from static analysis of the scripts. */
export interface ChoiceInfo {
  /** rejoin = continues in this scene; ends = scene ends; leaves = jumps to another scene's label. */
  dest: { k: 'rejoin' } | { k: 'ends' } | { k: 'leaves'; label: string };
  lines: number;
  secs: number;
  images: number;
  /** Images only reachable through this option (not the menu's other options). */
  uniqueImages: number;
  videos: number;
  chars: string[];
  changes: VarChange[];
  /** Scenes whose conditions check each changed variable. */
  usedIn: { v: string; scenes: string[]; total: number }[];
  /** If-branches: for each variable in the condition, which choices set it. */
  deps?: { v: string; setBy: { scene: string; choice: string; change: string }[] }[];
}

export interface LabelProgram {
  file: string;
  steps: Step[];
  /** Label execution falls through to when its block ends, if any. */
  next: string | null;
}

export interface ScenePrograms {
  schema: 1;
  /** Game resolution (from gui.init / config.screen_*), or null if unknown. */
  stage: { w: number; h: number } | null;
  labels: Record<string, LabelProgram>;
  /** Display names/colours for every speaker id used in programs. */
  speakers: Record<string, { name: string; color?: string }>;
  /** Whether each audio channel loops by default (music: true; custom channels from register_channel). */
  channels: Record<string, boolean>;
}
