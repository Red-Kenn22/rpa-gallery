/**
 * Turns parsed script statements into the gallery model:
 *   characters  – `define e = Character("Eileen")` (and Python equivalents)
 *   image map   – `image bg beach = "…"`, Movie(...), ATL, auto `images/` files
 *   scenes      – one per label: speakers, sprites shown, backgrounds,
 *                 videos, dialogue, thumbnail
 */

import type { CharacterInfo, DialogueLine, MediaKind, SceneInfo } from '../types';
import { callAt, findCalls, findStringLiterals, literalValue, stripTextTags } from './pyString';
import { extensionOf } from './rpaParser';
import type { ScriptFile, Stmt } from './scriptModel';

export const DIALOGUE_CAP = 400;

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'avif', 'bmp', 'gif', 'tga', 'svg']);
const VIDEO_EXT = new Set(['webm', 'mp4', 'm4v', 'ogv', 'mkv', 'avi', 'mpg', 'mpeg', 'mov']);
const AUDIO_EXT = new Set(['ogg', 'opus', 'mp3', 'wav', 'flac']);

export function mediaKind(path: string): MediaKind {
  const ext = extensionOf(path);
  if (IMAGE_EXT.has(ext)) return 'image';
  if (VIDEO_EXT.has(ext)) return 'video';
  if (AUDIO_EXT.has(ext)) return 'audio';
  return 'other';
}

const isVisual = (p: string) => {
  const k = mediaKind(p);
  return k === 'image' || k === 'video';
};

/** Resolves script-relative file names to canonical archive paths. */
export interface AssetLookup {
  resolve(path: string): string | null;
  paths(): Iterable<string>;
}

const NARRATORS = new Set(['narrator', 'centered', 'vcentered', 'nvl', 'adv', 'nvl_narrator', 'adv_narrator', 'name_only']);
const ENGINE_LABELS = new Set(['main_menu', 'before_main_menu', 'after_load', 'after_warp', 'quit', 'hide_windows']);
const CHARACTER_CALL = /(?:\w+\.)*(?:Character|ADVCharacter|NVLCharacter|DynamicCharacter|SpeakingCharacter)/;

interface CharDef {
  id: string;
  name: string | null;
  color?: string;
  imageTag?: string;
  kind?: string;
}

type ImageAlias = { file: string } | { ref: string };

// ─── Title formatting ───────────────────────────────────────────────────────

export function formatTitle(id: string): string {
  return id
    .split('.')
    .filter(Boolean)
    .map((part) =>
      part
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .replace(/([A-Za-z])(\d)/g, '$1 $2')
        .replace(/(\d)([A-Za-z])/g, '$1 $2')
        .split(/[_\s-]+/)
        .filter(Boolean)
        .map((w) => (w === w.toUpperCase() ? w : w[0].toUpperCase() + w.slice(1)))
        .join(' '),
    )
    .join(' · ');
}

// ─── Definitions ────────────────────────────────────────────────────────────

function cleanName(s: string): string {
  return stripTextTags(s).trim();
}

function parseCharacterExpr(source: string, varName: string, pos = 0): CharDef | null {
  const call = callAt(source, pos, CHARACTER_CALL);
  if (!call) return null;
  const { positional, keyword } = call.args;
  const nameExpr = positional[0] ?? keyword.name;
  let name: string | null = null;
  if (nameExpr !== undefined) {
    const lit = literalValue(nameExpr);
    if (lit !== null) name = /DynamicCharacter$/.test(call.callee) ? `[${lit}]` : cleanName(lit);
    else if (nameExpr.trim() === 'None') name = '';
    else name = `[${nameExpr.trim()}]`; // computed name, e.g. Character(player_name)
  }
  const color = literalValue(keyword.color) ?? literalValue(keyword.who_color) ?? undefined;
  const imageTag = literalValue(keyword.image) ?? undefined;
  const kind = keyword.kind?.trim();
  return { id: varName, name, color, imageTag, kind };
}

function aliasFromLiterals(lits: string[]): ImageAlias | null {
  const file = lits.find(isVisual);
  if (file) return { file };
  // renpy.easy.displayable: no "." and not "#color" → image reference
  const ref = lits.find((l) => l && !l.includes('.') && !l.startsWith('#') && !/[=()]/.test(l));
  return ref ? { ref } : null;
}

function aliasFromSource(source: string): ImageAlias | null {
  const movie = findCalls(source, /(?:\w+\.)*Movie/)[0];
  if (movie) {
    const play = literalValue(movie.args.keyword.play) ?? literalValue(movie.args.positional[0]);
    if (play) return { file: play };
  }
  return aliasFromLiterals(findStringLiterals(source).map((l) => l.value));
}

class Registry {
  readonly chars = new Map<string, CharDef>();
  readonly images = new Map<string, ImageAlias>();
  private byTag = new Map<string, string[][]>();
  private tagToChar = new Map<string, string>();
  private nameToChar = new Map<string, string>();
  private readonly assets: AssetLookup;

  constructor(assets: AssetLookup) {
    this.assets = assets;
  }

  collect(stmts: Stmt[]): void {
    for (const s of stmts) {
      switch (s.k) {
        case 'label':
          this.collect(s.body);
          break;
        case 'define':
          if (s.store === 'store' || s.store === 'store.character') {
            const def = parseCharacterExpr(s.source, s.name);
            if (def) this.chars.set(s.name, def);
          }
          break;
        case 'python':
          this.collectPython(s.source);
          break;
        case 'image': {
          const alias = s.source !== null ? aliasFromSource(s.source) : aliasFromLiterals(s.atl);
          if (alias) this.images.set(s.name.join(' ').toLowerCase(), alias);
          break;
        }
      }
    }
  }

  private collectPython(source: string): void {
    if (/Character\s*\(/.test(source)) {
      const assign = /(?:^|[\n;])[ \t]*(?:store\.)?([A-Za-z_]\w*)[ \t]*=[ \t]*/g;
      let m: RegExpExecArray | null;
      while ((m = assign.exec(source))) {
        const def = parseCharacterExpr(source, m[1], m.index + m[0].length);
        if (def) this.chars.set(m[1], def);
      }
    }
    if (source.includes('renpy.image')) {
      for (const call of findCalls(source, /renpy\.image/)) {
        const name = literalValue(call.args.positional[0]);
        const alias = call.args.positional[1] ? aliasFromSource(call.args.positional[1]) : null;
        if (name && alias) this.images.set(name.toLowerCase(), alias);
      }
    }
  }

  /** Call once after every script has been collected. */
  finish(): void {
    // Ren'Py auto-defines images from files under images/ (name = lowercased basename).
    for (const path of this.assets.paths()) {
      const lower = path.toLowerCase();
      if (!lower.startsWith('images/') || !isVisual(lower)) continue;
      const base = lower.slice(lower.lastIndexOf('/') + 1).replace(/\.[^.]+$/, '');
      const key = base.split(/\s+/).filter(Boolean).join(' ');
      if (key && !this.images.has(key)) this.images.set(key, { file: path });
    }
    for (const key of this.images.keys()) {
      const tokens = key.split(' ');
      const list = this.byTag.get(tokens[0]) ?? [];
      list.push(tokens);
      this.byTag.set(tokens[0], list);
    }
    for (const list of this.byTag.values()) list.sort((a, b) => a.length - b.length);

    // `kind=` inherits the parent's name when none was given.
    for (const def of this.chars.values()) {
      let parent = def.kind ? this.chars.get(def.kind) : undefined;
      for (let i = 0; def.name === null && parent && i < 8; i++) {
        if (parent.name !== null) def.name = parent.name;
        parent = parent.kind ? this.chars.get(parent.kind) : undefined;
      }
      if (def.name === null || def.name === '') def.name = def.id;
    }

    // Image tag → character, strongest signal first.
    for (const def of this.chars.values()) if (def.imageTag) this.tagToChar.set(def.imageTag.toLowerCase(), def.id);
    for (const def of this.chars.values()) {
      const v = def.id.toLowerCase();
      if (!this.tagToChar.has(v) && this.byTag.has(v)) this.tagToChar.set(v, def.id);
    }
    for (const def of this.chars.values()) {
      const n = (def.name ?? '').toLowerCase();
      if (/^[\w]+$/.test(n) && !this.tagToChar.has(n)) this.tagToChar.set(n, def.id);
      if (def.name && !this.nameToChar.has(def.name)) this.nameToChar.set(def.name, def.id);
    }
  }

  characterForTag(tag: string): string | undefined {
    return this.tagToChar.get(tag.toLowerCase());
  }

  /** `who` of a Say → character, null (narration) or 'extend'. */
  speaker(who: string | null): { id: string; name: string } | null | 'extend' {
    if (who == null) return null;
    const w = who.trim();
    const lit = literalValue(w);
    if (lit !== null) {
      const name = cleanName(lit);
      if (!name) return null;
      const id = this.nameToChar.get(name) ?? `name:${name}`;
      return { id, name };
    }
    const v = w.replace(/^store\./, '').replace(/^character\./, '');
    if (v === 'extend') return 'extend';
    if (NARRATORS.has(v)) return null;
    const def = this.chars.get(v);
    return { id: v, name: def?.name ?? v };
  }

  resolveFile(file: string): string | null {
    return this.assets.resolve(file);
  }

  resolveImage(tokens: string[], depth = 0): string | null {
    if (!tokens.length || depth > 8) return null;
    const lower = tokens.map((t) => t.toLowerCase());
    let alias = this.images.get(lower.join(' '));
    if (!alias) {
      // Attribute matching: smallest defined image with this tag containing all given attributes.
      const cands = this.byTag.get(lower[0]) ?? [];
      const hit = cands.find((c) => lower.every((t) => c.includes(t)));
      // Unknown attributes (e.g. transient expressions): fall back to fewer tokens.
      const fallback = hit ?? (lower.length > 1 ? undefined : cands[0]);
      if (fallback) alias = this.images.get(fallback.join(' '));
      else if (lower.length > 1) return this.resolveImage(tokens.slice(0, -1), depth + 1);
    }
    if (!alias) return null;
    if ('file' in alias) return this.resolveFile(alias.file);
    return this.resolveImage(alias.ref.split(/\s+/), depth + 1);
  }

  /** Image named by `show`/`scene` (name tokens or `expression "..."`). */
  resolveDisplayable(name: string[] | null, expr: string | null): string | null {
    if (expr) {
      const lit = literalValue(expr);
      if (lit === null) return null;
      return lit.includes('.') ? this.resolveFile(lit) : this.resolveImage(lit.split(/\s+/));
    }
    return name ? this.resolveImage(name) : null;
  }
}

// ─── Scenes ─────────────────────────────────────────────────────────────────

interface SceneAcc {
  id: string;
  file: string;
  line: number;
  speakerLines: Map<string, number>;
  appear: Set<string>;
  backgrounds: string[];
  images: string[];
  videos: string[];
  dialogue: DialogueLine[];
  dialogueCount: number;
  lastSpeaker: string | null;
}

function pushUnique(list: string[], v: string): void {
  if (!list.includes(v)) list.push(v);
}

export interface SceneParseResult {
  characters: CharacterInfo[];
  scenes: SceneInfo[];
  labels: number;
  referenced: Set<string>;
}

export function buildScenes(files: ScriptFile[], assets: AssetLookup): SceneParseResult {
  const reg = new Registry(assets);
  for (const f of files) reg.collect(f.stmts);
  reg.finish();

  const scenes: SceneInfo[] = [];
  const seen = new Set<string>();
  const charStats = new Map<string, CharacterInfo>();
  let labels = 0;

  const addMedia = (acc: SceneAcc, path: string | null, background = false) => {
    if (!path) return;
    const kind = mediaKind(path);
    if (kind === 'video') pushUnique(acc.videos, path);
    else if (kind === 'image') {
      pushUnique(acc.images, path);
      if (background) pushUnique(acc.backgrounds, path);
    }
  };

  const showByName = (acc: SceneAcc, tokens: string[] | null, expr: string | null, background: boolean) => {
    const tag = tokens?.[0];
    const charId = !background && tag ? reg.characterForTag(tag) : undefined;
    if (charId) acc.appear.add(charId);
    else addMedia(acc, reg.resolveDisplayable(tokens, expr), background);
  };

  const scanCode = (acc: SceneAcc, source: string) => {
    for (const lit of findStringLiterals(source)) {
      if (mediaKind(lit.value) === 'video') addMedia(acc, reg.resolveFile(lit.value));
    }
    if (source.includes('renpy.show') || source.includes('renpy.scene')) {
      for (const call of findCalls(source, /renpy\.(?:show|scene)/)) {
        const lit = literalValue(call.args.positional[0]);
        if (lit) showByName(acc, lit.split(/\s+/), null, call.callee === 'renpy.scene');
      }
    }
  };

  const walk = (acc: SceneAcc, body: Stmt[], file: string) => {
    for (const s of body) {
      switch (s.k) {
        case 'label':
          walkLabel(s, file);
          break;
        case 'say': {
          const sp = reg.speaker(s.who);
          let id: string | null;
          if (sp === 'extend') id = acc.lastSpeaker;
          else if (sp === null) id = null;
          else {
            id = sp.id;
            if (!charStats.has(id)) {
              const def = reg.chars.get(id);
              charStats.set(id, { id, name: sp.name, color: def?.color, sceneCount: 0, lineCount: 0 });
            }
          }
          acc.lastSpeaker = id;
          if (id) {
            acc.speakerLines.set(id, (acc.speakerLines.get(id) ?? 0) + 1);
            charStats.get(id)!.lineCount++;
          }
          acc.dialogueCount++;
          if (acc.dialogue.length < DIALOGUE_CAP) acc.dialogue.push({ who: id, what: stripTextTags(s.what) });
          break;
        }
        case 'menu':
          for (const c of s.choices) {
            acc.dialogueCount++;
            if (acc.dialogue.length < DIALOGUE_CAP) acc.dialogue.push({ who: null, what: stripTextTags(c), choice: true });
          }
          break;
        case 'scene':
          if (s.name || s.expr) showByName(acc, s.name, s.expr, true);
          break;
        case 'show':
          showByName(acc, s.name.length ? s.name : null, s.expr, false);
          break;
        case 'python':
          scanCode(acc, s.source);
          break;
        case 'user':
          scanCode(acc, s.text);
          break;
      }
    }
  };

  const walkLabel = (label: Extract<Stmt, { k: 'label' }>, file: string) => {
    labels++;
    const acc: SceneAcc = {
      id: label.name,
      file,
      line: label.line,
      speakerLines: new Map(),
      appear: new Set(),
      backgrounds: [],
      images: [],
      videos: [],
      dialogue: [],
      dialogueCount: 0,
      lastSpeaker: null,
    };
    walk(acc, label.body, file);
    if (seen.has(acc.id) || acc.id.startsWith('_') || ENGINE_LABELS.has(acc.id)) return;
    if (!acc.dialogueCount && !acc.images.length && !acc.videos.length) return;
    seen.add(acc.id);
    scenes.push(finishScene(acc));
  };

  const finishScene = (acc: SceneAcc): SceneInfo => {
    const speakers = [...acc.speakerLines.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
    const characters = [...speakers];
    for (const id of acc.appear) if (!characters.includes(id)) characters.push(id);
    for (const id of characters) {
      if (!charStats.has(id)) {
        const def = reg.chars.get(id);
        charStats.set(id, { id, name: def?.name ?? id, color: def?.color, sceneCount: 0, lineCount: 0 });
      }
      charStats.get(id)!.sceneCount++;
    }
    const thumb = acc.videos[0]
      ? { path: acc.videos[0], kind: 'video' as const }
      : acc.backgrounds[0] ?? acc.images[0]
        ? { path: (acc.backgrounds[0] ?? acc.images[0])!, kind: 'image' as const }
        : null;
    return {
      id: acc.id,
      title: formatTitle(acc.id),
      file: acc.file,
      line: acc.line,
      characters,
      speakers,
      backgrounds: acc.backgrounds,
      images: acc.images,
      videos: acc.videos,
      thumbnail: thumb,
      dialogue: acc.dialogue,
      dialogueCount: acc.dialogueCount,
    };
  };

  for (const f of files) {
    for (const s of f.stmts) if (s.k === 'label') walkLabel(s, f.path);
  }
  // Script order: by file, then line (nested labels are finished before their parent).
  const fileOrder = new Map(files.map((f, i) => [f.path, i]));
  scenes.sort((a, b) => (fileOrder.get(a.file) ?? 0) - (fileOrder.get(b.file) ?? 0) || a.line - b.line);

  const referenced = new Set<string>();
  for (const sc of scenes) {
    for (const p of sc.images) referenced.add(p);
    for (const p of sc.videos) referenced.add(p);
  }

  const characters = [...charStats.values()]
    .filter((c) => c.sceneCount > 0)
    .sort((a, b) => b.sceneCount - a.sceneCount || b.lineCount - a.lineCount || a.name.localeCompare(b.name));

  return { characters, scenes, labels, referenced };
}
