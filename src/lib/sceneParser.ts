/**
 * Turns parsed script statements into the gallery model:
 *   characters  – `define e = Character("Eileen")` (and Python equivalents)
 *   image map   – `image bg beach = "…"`, Movie(...), ATL, auto `images/` files
 *   scenes      – labels merged into whole scenes (continuations, menu
 *                 branches and rejoins, local labels), with speakers, sprites,
 *                 backgrounds, videos, dialogue, thumbnail and estimated time
 *   programs    – every label compiled for the scene player
 */

import type { CharacterInfo, DialogueLine, SceneInfo, ScenePrograms } from '../types';
import { isVisual, mediaKind } from './media';
import { annotateChoices } from './consequences';
import { compileLabel, programPaths } from './program';
import { callAt, findCalls, findStringLiterals, literalValue, stripTextTags } from './pyString';
import { childBlocks, type ScriptFile, type Stmt } from './scriptModel';

export { mediaKind } from './media';

export const DIALOGUE_CAP = 400;

/** Resolves script-relative file names to canonical archive paths. */
export interface AssetLookup {
  resolve(path: string): string | null;
  paths(): Iterable<string>;
}

const NARRATORS = new Set(['narrator', 'centered', 'vcentered', 'nvl', 'adv', 'nvl_narrator', 'adv_narrator', 'name_only']);
const ENGINE_LABELS = new Set(['main_menu', 'before_main_menu', 'after_load', 'after_warp', 'quit', 'hide_windows']);
const CHARACTER_CALL = /(?:\w+\.)*(?:Character|ADVCharacter|NVLCharacter|DynamicCharacter|SpeakingCharacter)/;

// Time estimate: ~200 words per minute plus a tap per line.
const WORDS_PER_SEC = 200 / 60;
const SECS_PER_LINE = 1;
const SECS_PER_IMAGE = 1.5;
const SECS_PER_PAUSE = 2;
const SECS_PER_VIDEO = 6;
const SECS_PER_MENU = 3;

interface CharDef {
  id: string;
  name: string | null;
  color?: string;
  imageTag?: string;
  kind?: string;
  /** Character(None) or no name at all: a styled narrator, not a person. */
  nameless?: boolean;
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

/** Recursively visits every statement (including inside labels, menus, ifs). */
function forEachStmt(stmts: Stmt[], fn: (s: Stmt) => void): void {
  for (const s of stmts) {
    fn(s);
    for (const b of childBlocks(s)) forEachStmt(b, fn);
  }
}

export class Registry {
  readonly chars = new Map<string, CharDef>();
  readonly images = new Map<string, ImageAlias>();
  /** `define audio.theme = "music/theme.ogg"` → theme → music/theme.ogg */
  readonly audio = new Map<string, string>();
  /** Channel → loops by default. */
  readonly channels: Record<string, boolean> = { music: true, sound: false, voice: false, audio: false };
  stage: { w: number; h: number } | null = null;
  private byTag = new Map<string, string[][]>();
  private tagToChar = new Map<string, string>();
  private nameToChar = new Map<string, string>();
  private readonly assets: AssetLookup;

  constructor(assets: AssetLookup) {
    this.assets = assets;
  }

  collect(stmts: Stmt[]): void {
    forEachStmt(stmts, (s) => {
      switch (s.k) {
        case 'define':
          if (s.store === 'store' || s.store === 'store.character') {
            const def = parseCharacterExpr(s.source, s.name);
            if (def) this.chars.set(s.name, def);
          }
          if (s.store === 'store.audio') {
            const file = literalValue(s.source);
            if (file) this.audio.set(s.name, file);
          }
          if (s.store === 'store.config' && (s.name === 'screen_width' || s.name === 'screen_height')) {
            const n = parseInt(s.source, 10);
            if (n > 0) this.setStage(s.name === 'screen_width' ? n : undefined, s.name === 'screen_height' ? n : undefined);
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
    });
  }

  private setStage(w?: number, h?: number): void {
    const cur = this.stage ?? { w: 0, h: 0 };
    this.stage = { w: w ?? cur.w, h: h ?? cur.h };
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
    if (source.includes('audio.')) {
      for (const m of source.matchAll(/(?:^|[\n;])\s*audio\.(\w+)\s*=\s*(["'][^"'\n]+["'])/g)) {
        const file = literalValue(m[2]);
        if (file) this.audio.set(m[1], file);
      }
    }
    if (source.includes('register_channel')) {
      for (const c of findCalls(source, /renpy\.(?:music|audio)\.register_channel/)) {
        const name = literalValue(c.args.positional[0]);
        const loop = (c.args.keyword.loop ?? c.args.positional[2] ?? '').trim();
        // Ren'Py: loop=None (not given) means sounds on the channel loop by default.
        if (name) this.channels[name] = loop === '' || loop === 'None' || loop === 'True' || loop === '1';
      }
    }
    const gui = /gui\.init\(\s*(\d+)\s*,\s*(\d+)\s*\)/.exec(source);
    if (gui) this.setStage(+gui[1], +gui[2]);
    const sw = /config\.screen_width\s*=\s*(\d+)/.exec(source);
    const sh = /config\.screen_height\s*=\s*(\d+)/.exec(source);
    if (sw || sh) this.setStage(sw ? +sw[1] : undefined, sh ? +sh[1] : undefined);
  }

  /** Call once after every script has been collected. */
  finish(): void {
    if (this.stage && (!this.stage.w || !this.stage.h)) this.stage = null;
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
      if (def.name === null || def.name === '') {
        def.name = def.id;
        def.nameless = true;
      }
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

  /** Image files of every image whose tag belongs to this character (sprites, side images). */
  spritePaths(charId: string): { path: string; side: boolean }[] {
    const out: { path: string; side: boolean }[] = [];
    for (const key of this.images.keys()) {
      const tokens = key.split(' ');
      const side = tokens[0] === 'side' && tokens.length > 1;
      const tag = side ? tokens[1] : tokens[0];
      if (this.tagToChar.get(tag) !== charId) continue;
      const path = this.resolveImage(tokens);
      if (path && mediaKind(path) === 'image' && !out.some((o) => o.path === path)) out.push({ path, side });
    }
    return out;
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
    if (def?.nameless) return null;
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

  /** Audio named in a play/queue/voice statement: a file literal or an `audio.` alias. */
  resolveAudio(expr: string): string | null {
    const lit = literalValue(expr);
    if (lit !== null) {
      const file = lit.replace(/^<[^>]*>/, ''); // "<from 5 to 10>file.ogg"
      return this.resolveFile(file) ?? (this.audio.has(file) ? this.resolveFile(this.audio.get(file)!) : null);
    }
    const name = expr.trim().replace(/^(?:store\.)?audio\./, '');
    const alias = this.audio.get(name);
    return alias ? this.resolveFile(alias.replace(/^<[^>]*>/, '')) : null;
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

// ─── Label graph ────────────────────────────────────────────────────────────

interface LabelNode {
  name: string;
  file: string;
  /** Global script order (file order, then position). */
  order: number;
  line: number;
  body: Stmt[];
  /** Label that runs when this one's block ends without jump/return. */
  fallNext: string | null;
  parent: string | null;
}

type EdgeKind = 'jump' | 'branch' | 'call' | 'fall';
interface Edge {
  from: string;
  to: string;
  kind: EdgeKind;
}

/**
 * Can a block run off its end? False when its last statement always leaves:
 * jump/return, a nested label, or a menu/if whose every branch leaves.
 */
function completes(body: Stmt[]): boolean {
  for (let i = body.length - 1; i >= 0; i--) {
    const s = body[i];
    if (s.k === 'define' || s.k === 'image') continue;
    if (s.k === 'jump' || s.k === 'return' || s.k === 'label') return false;
    if (s.k === 'python') return !/renpy\.jump\s*\(/.test(s.source);
    if (s.k === 'menu') return s.choices.some((c) => completes(c.body));
    if (s.k === 'if') return !s.entries.some((e) => e.cond === 'True') || s.entries.some((e) => completes(e.body));
    return true;
  }
  return true;
}

function collectLabels(files: ScriptFile[]): Map<string, LabelNode> {
  const labels = new Map<string, LabelNode>();
  let order = 0;
  for (const f of files) {
    const top = f.stmts.filter((s): s is Extract<Stmt, { k: 'label' }> => s.k === 'label');
    top.forEach((l, i) => {
      const fallNext = top[i + 1]?.name ?? null;
      const visit = (node: Extract<Stmt, { k: 'label' }>, parent: string | null, next: string | null) => {
        if (!labels.has(node.name)) {
          labels.set(node.name, { name: node.name, file: f.path, order: order++, line: node.line, body: node.body, fallNext: next, parent });
        }
        forEachStmt(node.body, (s) => {
          if (s.k === 'label') visit(s, node.name, next);
        });
      };
      visit(l, null, fallNext);
    });
  }
  return labels;
}

function collectEdges(labels: Map<string, LabelNode>): Edge[] {
  const edges: Edge[] = [];
  for (const l of labels.values()) {
    const scan = (stmts: Stmt[], inBranch: boolean) => {
      for (const s of stmts) {
        if (s.k === 'jump') edges.push({ from: l.name, to: s.target, kind: inBranch ? 'branch' : 'jump' });
        else if (s.k === 'call') edges.push({ from: l.name, to: s.target, kind: 'call' });
        else if (s.k === 'label') {
          edges.push({ from: l.name, to: s.name, kind: inBranch ? 'branch' : 'fall' });
          return; // the nested label scans its own body
        } else if (s.k === 'menu') s.choices.forEach((c) => scan(c.body, true));
        else if (s.k === 'if') s.entries.forEach((e) => scan(e.body, true));
        else if (s.k === 'while') scan(s.body, inBranch);
        else if (s.k === 'python' && /renpy\.(?:jump|call)/.test(s.source)) {
          for (const c of findCalls(s.source, /renpy\.(?:jump|call)/)) {
            const t = literalValue(c.args.positional[0]);
            if (t) edges.push({ from: l.name, to: t, kind: c.callee === 'renpy.call' ? 'call' : inBranch ? 'branch' : 'jump' });
          }
        }
      }
    };
    scan(l.body, false);
    if (l.fallNext && completes(l.body)) edges.push({ from: l.name, to: l.fallNext, kind: 'fall' });
  }
  return edges.filter((e) => labels.has(e.to) && e.to !== e.from);
}

/** Explicit continuation suffixes: _part2, _cont, -pt3, .end … */
function continuationStem(name: string): string {
  return name.toLowerCase().replace(/[_\-.]?(?:part|pt|cont|continued|continue|end)[_\-]?\d*$/, '');
}

/**
 * Groups labels into scenes. A label joins its predecessor's scene when every
 * way into it comes from that one scene AND it is either a local label
 * (`parent.sub`), only reached from menu choices / if branches or the labels
 * they lead to (branch content and rejoins), or an explicitly named
 * continuation (`x_part2` after `x`). Plain
 * linear jumps to differently named labels start a new scene, so a linear
 * game doesn't collapse into one giant scene.
 */
/** Say statements in a label's own body (menus and ifs included, nested labels not). */
function countSays(body: Stmt[]): number {
  let n = 0;
  for (const s of body) {
    if (s.k === 'say') n++;
    else if (s.k === 'menu') for (const c of s.choices) n += countSays(c.body);
    else if (s.k === 'if') for (const e of s.entries) n += countSays(e.body);
    else if (s.k === 'while') n += countSays(s.body);
  }
  return n;
}

/**
 * A label reached from a menu with this many lines of its own is a scene in its
 * own right (a date picked from a menu), not a branch of the menu's scene.
 */
export const BIG_LABEL_LINES = 100;

function mergeScenes(labels: Map<string, LabelNode>, edges: Edge[]): Map<string, string[]> {
  const incoming = new Map<string, Edge[]>();
  for (const e of edges) {
    const list = incoming.get(e.to) ?? [];
    list.push(e);
    incoming.set(e.to, list);
  }
  const sceneOf = new Map<string, string>();
  const branchMember = new Set<string>();
  const ordered = [...labels.values()].sort((a, b) => a.order - b.order);

  for (const l of ordered) {
    const ins = incoming.get(l.name) ?? [];
    const scenesIn = new Set(ins.map((e) => sceneOf.get(e.from)));
    let target: string | undefined;
    if (ins.length && scenesIn.size === 1 && !scenesIn.has(undefined)) {
      const s = [...scenesIn][0]!;
      const sameFile = labels.get(s)!.file === l.file;
      const local = l.parent !== null && sceneOf.get(l.parent) === s;
      // Branch content or a rejoin: every way in is a menu/if choice or comes from branch content.
      // (A label that is also the scene's plain linear exit stays a scene of its own.)
      const viaBranch = ins.every((e) => e.kind === 'branch' || branchMember.has(e.from));
      const continuation = ins.some((e) => {
        const a = continuationStem(e.from);
        const b = continuationStem(l.name);
        return b.length > 1 && a === b;
      });
      const big = countSays(l.body) >= BIG_LABEL_LINES;
      if (local || (sameFile && (continuation || (viaBranch && !big)))) target = s;
      if (target && ins.some((e) => e.kind === 'branch')) branchMember.add(l.name);
    }
    sceneOf.set(l.name, target ?? l.name);
  }

  const scenes = new Map<string, string[]>();
  for (const l of ordered) {
    const s = sceneOf.get(l.name)!;
    const list = scenes.get(s) ?? [];
    list.push(l.name);
    scenes.set(s, list);
  }
  return scenes;
}

// ─── Time estimate ──────────────────────────────────────────────────────────

function readingSecs(text: string): number {
  const words = Math.max(text.split(/\s+/).filter(Boolean).length, text.length / 6);
  return words / WORDS_PER_SEC + SECS_PER_LINE;
}

/** Typical-path duration: menus/ifs count the average branch; jumps follow into the scene. */
function estimateDuration(entry: string, members: Set<string>, labels: Map<string, LabelNode>): number {
  const visiting = new Set<string>();
  const memo = new Map<string, number>();

  const label = (name: string): number => {
    if (memo.has(name)) return memo.get(name)!;
    if (visiting.has(name) || !members.has(name)) return 0;
    visiting.add(name);
    const node = labels.get(name)!;
    const r = block(node.body);
    let total = r.secs;
    if (!r.stopped && node.fallNext && members.has(node.fallNext)) total += label(node.fallNext);
    visiting.delete(name);
    memo.set(name, total);
    return total;
  };

  const block = (stmts: Stmt[]): { secs: number; stopped: boolean } => {
    let secs = 0;
    for (let i = 0; i < stmts.length; i++) {
      const s = stmts[i];
      switch (s.k) {
        case 'say':
          secs += readingSecs(s.what);
          break;
        case 'scene':
          if (s.name || s.expr) secs += stmts[i + 1]?.k === 'say' ? 0 : SECS_PER_IMAGE;
          break;
        case 'user':
          if (/^pause\b/.test(s.text)) secs += SECS_PER_PAUSE;
          else if (findStringLiterals(s.text).some((l) => mediaKind(l.value) === 'video')) secs += SECS_PER_VIDEO;
          break;
        case 'python':
          if (/renpy\.pause\s*\(/.test(s.source)) secs += SECS_PER_PAUSE;
          if (/renpy\.movie_cutscene\s*\(/.test(s.source)) secs += SECS_PER_VIDEO;
          break;
        case 'menu': {
          const parts = s.choices.map((c) => block(c.body));
          secs += SECS_PER_MENU + (parts.length ? parts.reduce((a, p) => a + p.secs, 0) / parts.length : 0);
          break;
        }
        case 'if': {
          const parts = s.entries.map((e) => block(e.body));
          secs += parts.length ? parts.reduce((a, p) => a + p.secs, 0) / parts.length : 0;
          break;
        }
        case 'while':
          secs += block(s.body).secs;
          break;
        case 'call':
          secs += label(s.target);
          break;
        case 'jump':
          return { secs: secs + label(s.target), stopped: true };
        case 'label':
          return { secs: secs + label(s.name), stopped: true };
        case 'return':
          return { secs, stopped: true };
      }
    }
    return { secs, stopped: false };
  };

  return Math.round(label(entry));
}

// ─── Portraits ──────────────────────────────────────────────────────────────

/** Folders whose images are pictures of characters (bios, portraits, side images…). */
const PORTRAIT_DIRS = /(?:^|\/)(?:portraits?|profiles?|bios?|biograph(?:y|ies)|side|chars?|characters?|cast|select|cards?|avatars?|faces?|busts?|contacts?|people)(?:\/|_|$)/;
/** Gallery / replay thumbnails: real pictures of the character, usually from scenes. */
const GALLERY_DIRS = /(?:^|\/)(?:gallery|galleries|replays?|cgs?)(?:\/|_|$)/;
/** Interface art: never a portrait. */
const UI_PATH = /(?:^|\/)(?:gui|ui|interface|menus?|buttons?|icons?|hud|minigames?|lock|combination lock)\//;
const UI_WORDS = new Set([
  'button', 'btn', 'hover', 'idle', 'selected', 'insensitive', 'icon', 'chibi', 'emoji', 'menu', 'overlay', 'frame',
  'bar', 'slider', 'scrollbar', 'thumb', 'cursor', 'lock', 'logo', 'title', 'textbox', 'namebox', 'presplash',
  'splash', 'heart', 'locked', 'unlock', 'arrow', 'back', 'background', 'filter', 'mask', 'black', 'white', 'blank',
]);
const PLAIN_SCREEN = /(?:^|\/)(?:black|white|blank|empty|transparent|solid)[^/]*$/;

/** Words a file must contain to be "named after" the character (from the display name). */
function nameKeys(c: CharacterInfo): string[] {
  const keys = new Set<string>();
  const raw = c.name.replace(/\[[^\]]*\]/g, ' ').toLowerCase();
  const words = raw.split(/[^a-z]+/).filter((w) => w.length >= 3);
  if (words.length) {
    keys.add(words.join(''));
    keys.add(words[0]);
  }
  // A long, word-like variable name (e.g. "lucy") counts too; short ones ("no", "eli") match too much.
  const id = c.id.replace(/^name:/, '').toLowerCase();
  if (/^[a-z]{4,}$/.test(id)) keys.add(id);
  for (const k of keys) if (UI_WORDS.has(k)) keys.delete(k);
  return [...keys];
}

const MAX_PORTRAIT_CHOICES = 12;

function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

/**
 * Guesses a picture for each character, best first:
 *   image files named after them (more so in bio/portrait/side folders, then
 *   gallery folders) → their sprites / side images → images from scenes they lead.
 * Interface art (gui/, menus, buttons, chibis…) and plain black/white screens are skipped.
 */
function pickPortraits(chars: CharacterInfo[], scenes: SceneInfo[], reg: Registry, assets: AssetLookup, referenced: Set<string>, protagonist: string | null): void {
  const images = [...assets.paths()].filter((p) => mediaKind(p) === 'image');
  const parsed = images
    .map((p) => {
      const lower = p.toLowerCase();
      const base = lower.slice(lower.lastIndexOf('/') + 1).replace(/\.[^.]+$/, '');
      // "ga_nancy1" → ga, nancy; "lk_penelope0" → lk, penelope
      return { p, lower, base, tokens: base.split(/[^a-z]+/).filter(Boolean) };
    })
    .filter((f) => !UI_PATH.test(f.lower) && !f.tokens.some((t) => UI_WORDS.has(t)) && !PLAIN_SCREEN.test(f.lower));
  const usable = (p: string) => {
    const lower = p.toLowerCase();
    return !UI_PATH.test(lower) && !PLAIN_SCREEN.test(lower);
  };

  for (const c of chars) {
    const scored = new Map<string, number>();
    const add = (p: string, score: number) => scored.set(p, Math.max(scored.get(p) ?? 0, score));
    const keys = nameKeys(c);
    if (keys.length) {
      for (const f of parsed) {
        let score = 0;
        for (const k of keys) {
          if (f.tokens.length === 1 && f.tokens[0] === k) score = Math.max(score, 6);
          else if (f.tokens.includes(k)) score = Math.max(score, 3);
        }
        if (!score) continue;
        if (PORTRAIT_DIRS.test(f.lower)) score += 3;
        else if (GALLERY_DIRS.test(f.lower)) score += 2;
        if (/(?:^|[/_ ])(?:bg|scene|ev)(?:[/_ \d]|$)/.test(f.lower)) score -= 1;
        add(f.p, score);
      }
    }
    for (const s of reg.spritePaths(c.id)) if (usable(s.path)) add(s.path, s.side ? 5 : 4);
    // Fallback: a picture from the middle of scenes this character leads (first shots are often empty rooms).
    {
      let n = 0;
      for (const sc of scenes) {
        if (n >= 6) break;
        if (!sc.characters.includes(c.id)) continue;
        const pics = sc.images.filter(usable);
        if (!pics.length) continue;
        const lead = sc.speakers.find((id) => id !== protagonist) === c.id;
        add(pics[Math.floor(pics.length * 0.4)], (lead ? 1 : 0.5) - n++ * 0.01);
      }
    }
    const sorted = [...scored.entries()].sort((a, b) => b[1] - a[1] || naturalCompare(a[0], b[0])).map(([p]) => p);
    // Variety for the picker: at most 4 choices per folder first, then the rest.
    const perDir = new Map<string, number>();
    const varied: string[] = [];
    const later: string[] = [];
    for (const p of sorted) {
      const dir = p.slice(0, p.lastIndexOf('/') + 1);
      const n = perDir.get(dir) ?? 0;
      perDir.set(dir, n + 1);
      (n < 4 ? varied : later).push(p);
    }
    const ranked = [...varied, ...later].slice(0, MAX_PORTRAIT_CHOICES);
    if (ranked.length) {
      c.portrait = ranked[0];
      c.portraitCandidates = ranked;
      ranked.forEach((p) => referenced.add(p));
    }
  }
}

// ─── Characters: merging and roles ──────────────────────────────────────────

/**
 * Speakers with the same display name are one character on screen (games often
 * define variants such as `mc`, `mct` for thoughts, `mcsc` for a phone screen).
 * The variant with the most lines keeps its id; scenes are rewritten to use it.
 */
function mergeSameNamed(chars: CharacterInfo[], scenes: SceneInfo[]): CharacterInfo[] {
  const byName = new Map<string, CharacterInfo[]>();
  for (const c of chars) {
    const k = c.name.trim().toLowerCase();
    const g = byName.get(k);
    if (g) g.push(c);
    else byName.set(k, [c]);
  }
  if (byName.size === chars.length) return chars;
  const canon = new Map<string, string>();
  const out: CharacterInfo[] = [];
  for (const group of byName.values()) {
    group.sort((a, b) => b.lineCount - a.lineCount || b.sceneCount - a.sceneCount);
    const head = group[0];
    if (group.length > 1) {
      head.aliases = group.slice(1).map((c) => c.id);
      head.lineCount = group.reduce((n, c) => n + c.lineCount, 0);
      head.color ??= group.find((c) => c.color)?.color;
    }
    for (const c of group) canon.set(c.id, head.id);
    out.push(head);
  }
  const remap = (ids: string[]) => {
    const r: string[] = [];
    for (const id of ids) {
      const c = canon.get(id) ?? id;
      if (!r.includes(c)) r.push(c);
    }
    return r;
  };
  const byId = new Map(out.map((c) => [c.id, c]));
  for (const c of out) c.sceneCount = 0;
  for (const sc of scenes) {
    sc.speakers = remap(sc.speakers);
    sc.characters = remap(sc.characters);
    for (const d of sc.dialogue) if (d.who) d.who = canon.get(d.who) ?? d.who;
    for (const id of sc.characters) {
      const c = byId.get(id);
      if (c) c.sceneCount++;
    }
  }
  return out;
}

/** At most this many characters get a card on the Characters screen. */
const MAX_MAIN_CHARACTERS = 16;

/**
 * Marks the player character (in most scenes, or a "[name]" speaker in many)
 * and splits the rest into main and minor characters by how much they speak.
 * Returns the protagonist's id, if any.
 */
function assignRoles(chars: CharacterInfo[], sceneTotal: number): string | null {
  let protagonist: CharacterInfo | undefined;
  const top = [...chars].sort((a, b) => b.sceneCount - a.sceneCount)[0];
  if (top && sceneTotal >= 10 && (top.sceneCount >= sceneTotal * 0.6 || (top.name.includes('[') && top.sceneCount >= sceneTotal * 0.3))) {
    protagonist = top;
    top.role = 'protagonist';
  }
  const rest = chars.filter((c) => c !== protagonist).sort((a, b) => b.lineCount - a.lineCount);
  // Small casts: everyone gets a card. Big casts: only those with a real share of the dialogue.
  const threshold = rest.length > 8 ? (rest[0]?.lineCount ?? 0) * 0.15 : 0;
  rest.forEach((c, i) => {
    c.role = i < MAX_MAIN_CHARACTERS && c.lineCount >= threshold ? 'main' : 'minor';
  });
  return protagonist?.id ?? null;
}

// ─── Scenes ─────────────────────────────────────────────────────────────────

interface SceneAcc {
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
  programs: ScenePrograms;
}

export function buildScenes(files: ScriptFile[], assets: AssetLookup): SceneParseResult {
  const reg = new Registry(assets);
  for (const f of files) reg.collect(f.stmts);
  reg.finish();

  const labels = collectLabels(files);
  const edges = collectEdges(labels);
  const groups = mergeScenes(labels, edges);

  const charStats = new Map<string, CharacterInfo>();
  const ensureChar = (id: string, name: string) => {
    if (!charStats.has(id)) {
      const def = reg.chars.get(id);
      charStats.set(id, { id, name: def?.name ?? name, color: def?.color, sceneCount: 0, lineCount: 0 });
    }
    return charStats.get(id)!;
  };

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

  const walk = (acc: SceneAcc, body: Stmt[]) => {
    for (const s of body) {
      switch (s.k) {
        case 'label':
          break; // nested labels are scenes (or scene parts) of their own
        case 'say': {
          const sp = reg.speaker(s.who);
          let id: string | null;
          if (sp === 'extend') id = acc.lastSpeaker;
          else if (sp === null) id = null;
          else {
            id = sp.id;
            ensureChar(id, sp.name);
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
            if (acc.dialogue.length < DIALOGUE_CAP) acc.dialogue.push({ who: null, what: stripTextTags(c.text), choice: true });
          }
          for (const c of s.choices) walk(acc, c.body);
          break;
        case 'if':
          for (const e of s.entries) walk(acc, e.body);
          break;
        case 'while':
          walk(acc, s.body);
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

  const scenes: SceneInfo[] = [];
  for (const [entry, members] of groups) {
    if (entry.startsWith('_') || ENGINE_LABELS.has(entry)) continue;
    const acc: SceneAcc = {
      speakerLines: new Map(),
      appear: new Set(),
      backgrounds: [],
      images: [],
      videos: [],
      dialogue: [],
      dialogueCount: 0,
      lastSpeaker: null,
    };
    for (const name of members) walk(acc, labels.get(name)!.body);
    if (!acc.dialogueCount && !acc.images.length && !acc.videos.length) continue;

    const speakers = [...acc.speakerLines.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
    const characters = [...speakers];
    for (const id of acc.appear) if (!characters.includes(id)) characters.push(id);
    for (const id of characters) ensureChar(id, id).sceneCount++;

    const first = acc.videos[0]
      ? { path: acc.videos[0], kind: 'video' as const }
      : acc.backgrounds[0] ?? acc.images[0]
        ? { path: (acc.backgrounds[0] ?? acc.images[0])!, kind: 'image' as const }
        : null;
    const node = labels.get(entry)!;
    scenes.push({
      id: entry,
      labels: members,
      durationSec: estimateDuration(entry, new Set(members), labels),
      title: formatTitle(entry),
      file: node.file,
      line: node.line,
      characters,
      speakers,
      backgrounds: acc.backgrounds,
      images: acc.images,
      videos: acc.videos,
      thumbnail: first,
      dialogue: acc.dialogue,
      dialogueCount: acc.dialogueCount,
    });
  }
  scenes.sort((a, b) => labels.get(a.id)!.order - labels.get(b.id)!.order);

  // ── Player programs for every label ──
  const programs: ScenePrograms = { schema: 1, stage: reg.stage, labels: {}, speakers: {}, channels: reg.channels };
  const referenced = new Set<string>();
  for (const sc of scenes) {
    sc.images.forEach((p) => referenced.add(p));
    sc.videos.forEach((p) => referenced.add(p));
  }
  for (const l of labels.values()) {
    const steps = compileLabel(l.body, reg);
    programs.labels[l.name] = { file: l.file, steps, next: completes(l.body) ? l.fallNext : null };
    programPaths(steps, referenced);
    for (const s of steps) {
      if (s.t === 'say' && s.who && !programs.speakers[s.who]) {
        const c = charStats.get(s.who) ?? ensureChar(s.who, s.who.replace(/^name:/, ''));
        programs.speakers[s.who] = c.color ? { name: c.name, color: c.color } : { name: c.name };
      }
    }
  }

  annotateChoices(programs, scenes);
  const merged = mergeSameNamed([...charStats.values()], scenes).filter((c) => c.sceneCount > 0);
  const protagonist = assignRoles(merged, scenes.length);
  pickPortraits(merged, scenes, reg, assets, referenced, protagonist);

  const characters = merged.sort((a, b) => b.sceneCount - a.sceneCount || b.lineCount - a.lineCount || a.name.localeCompare(b.name));

  return { characters, scenes, labels: labels.size, referenced, programs };
}
