/**
 * The game's own replay gallery, read from its scripts.
 *
 * Two shapes are recognised:
 *   1. A data list driving a gallery screen, e.g. (Eternum)
 *        define replays = [["db 62", "ga_dalia1", "ga_dalia1", _("Shower Show"), ["exhibition"], ["dalia"], ["mc"]], …]
 *      Columns are classified by content: the one holding label names is the
 *      replay label, one naming gallery images is the thumbnail, a translated
 *      string is the title, and a list of names matching characters is who's
 *      in it. A dict mapping those names to display names gives the filter
 *      groups their labels ({"side": _("Side Girls")}).
 *   2. Literal screen buttons: `imagebutton idle "gallery/x.png" action Replay("label")`.
 */
import type { CharacterInfo, ReplayGallery, ReplayInfo } from '../types';

// ─── Python literals ────────────────────────────────────────────────────────

export type PyLit = string | number | boolean | null | PyLit[] | { tr: string } | { dict: [PyLit, PyLit][] };

/** Parses a Python literal (lists, tuples, dicts, strings, numbers, _("…")). Undefined if it isn't one. */
export function parsePyLiteral(src: string): PyLit | undefined {
  let i = 0;
  const ws = () => {
    for (;;) {
      while (i < src.length && /\s/.test(src[i])) i++;
      if (src[i] === '#') while (i < src.length && src[i] !== '\n') i++;
      else return;
    }
  };
  const fail = Symbol('fail');
  const str = (): string | typeof fail => {
    let j = i;
    while (j < src.length && /[rRuUbB]/.test(src[j]) && j - i < 2) j++;
    const raw = /[rR]/.test(src.slice(i, j));
    const q = src[j];
    if (q !== '"' && q !== "'") return fail;
    const triple = src.startsWith(q.repeat(3), j);
    const end = triple ? q.repeat(3) : q;
    j += end.length;
    let out = '';
    while (j < src.length && !src.startsWith(end, j)) {
      const c = src[j];
      if (c === '\\' && !raw) {
        const n = src[j + 1];
        out += n === 'n' ? '\n' : n === 't' ? '\t' : n === '\n' ? '' : n;
        j += 2;
      } else {
        if (c === '\n' && !triple) return fail;
        out += c;
        j++;
      }
    }
    if (j >= src.length) return fail;
    i = j + end.length;
    return out;
  };
  const value = (): PyLit | typeof fail => {
    ws();
    const c = src[i];
    if (c === '[' || c === '(') {
      const close = c === '[' ? ']' : ')';
      i++;
      const items: PyLit[] = [];
      for (;;) {
        ws();
        if (src[i] === close) {
          i++;
          return items;
        }
        const v = value();
        if (v === fail) return fail;
        items.push(v);
        ws();
        if (src[i] === ',') i++;
        else if (src[i] !== close) return fail;
      }
    }
    if (c === '{') {
      i++;
      const entries: [PyLit, PyLit][] = [];
      for (;;) {
        ws();
        if (src[i] === '}') {
          i++;
          return { dict: entries };
        }
        const k = value();
        if (k === fail) return fail;
        ws();
        if (src[i] !== ':') return fail;
        i++;
        const v = value();
        if (v === fail) return fail;
        entries.push([k, v]);
        ws();
        if (src[i] === ',') i++;
        else if (src[i] !== '}') return fail;
      }
    }
    const tr = /^_{1,3}\s*\(/.exec(src.slice(i, i + 6));
    if (tr) {
      i += tr[0].length;
      ws();
      const s = str();
      if (s === fail) return fail;
      ws();
      if (src[i] !== ')') return fail;
      i++;
      return { tr: s };
    }
    const s = str();
    if (s !== fail) {
      // Adjacent literals concatenate: "a" "b".
      let acc = s;
      for (;;) {
        const save = i;
        ws();
        const more = str();
        if (more === fail) {
          i = save;
          return acc;
        }
        acc += more;
      }
    }
    const num = /^-?\d+(?:\.\d+)?/.exec(src.slice(i));
    if (num) {
      i += num[0].length;
      return Number(num[0]);
    }
    for (const [word, v] of [['True', true], ['False', false], ['None', null]] as const) {
      if (src.startsWith(word, i) && !/\w/.test(src[i + word.length] ?? '')) {
        i += word.length;
        return v;
      }
    }
    return fail;
  };
  const v = value();
  if (v === fail) return undefined;
  ws();
  return i >= src.length ? v : undefined;
}

const text = (v: PyLit | undefined): string | null => (typeof v === 'string' ? v : v && typeof v === 'object' && 'tr' in v ? v.tr : null);
const isList = (v: PyLit | undefined): v is PyLit[] => Array.isArray(v);

// ─── Recognising a replay list ──────────────────────────────────────────────

export interface ReplayButton {
  label: string;
  /** Displayable given as the button's image (idle/ground), if any. */
  image?: string;
  /** Button text (textbutton), if any. */
  text?: string;
}

export interface GalleryInputs {
  /** Python literal sources: `define x = <here>` values and `x = <here>` assignments in python blocks. */
  literals: string[];
  /** Literal Replay("label") buttons found in screens. */
  buttons: ReplayButton[];
  labels: Set<string>;
  /** Scene id containing a label. */
  sceneOf: (label: string) => string | null;
  /** Archive path of an image named by a displayable string ("gallery/x.png", "bg beach"), if any. */
  resolveImage: (displayable: string) => string | null;
  /** Archive image paths by lowercase basename (no extension). */
  imagesByBase: Map<string, string[]>;
  characters: CharacterInfo[];
  formatTitle: (label: string) => string;
}

const GALLERY_DIR = /(?:^|\/)(?:gallery|galleries|replays?|thumbs?|thumbnails?|unlock\w*)\//i;

/** Display names for group keys: the dict literal covering most of them ({"side": _("Side Girls")}). */
function groupNames(dicts: [PyLit, PyLit][][], keys: string[]): Map<string, string> {
  let best = new Map<string, string>();
  for (const entries of dicts) {
    const m = new Map<string, string>();
    for (const [k, v] of entries) {
      const ks = text(k);
      const vs = text(v);
      if (ks && vs) m.set(ks, vs.replace(/\{[^}]*\}/g, '').trim());
    }
    const hits = keys.filter((k) => m.has(k)).length;
    if (hits > keys.filter((k) => best.has(k)).length && hits >= Math.ceil(keys.length * 0.6)) best = m;
  }
  return best;
}

function matchCharacter(key: string, display: string | undefined, chars: CharacterInfo[]): string | null {
  const wants = [key, display ?? ''].map((s) => s.toLowerCase().trim()).filter(Boolean);
  for (const c of chars) {
    const n = c.name.toLowerCase().trim();
    const first = n.split(/\s+/)[0];
    if (wants.some((w) => w === n || w === first)) return c.id;
  }
  return null;
}

export function buildReplayGallery(inp: GalleryInputs): ReplayGallery | undefined {
  const parsed = inp.literals.map(parsePyLiteral).filter((v): v is PyLit => v !== undefined);
  const dicts = parsed.filter((v): v is { dict: [PyLit, PyLit][] } => !!v && typeof v === 'object' && 'dict' in v).map((d) => d.dict);
  const imageFor = (name: string): { path: string; gallery: boolean } | null => {
    const base = name.toLowerCase().replace(/^.*\//, '').replace(/\.[a-z0-9]+$/, '');
    const hits = inp.imagesByBase.get(base);
    if (!hits?.length) return null;
    const g = hits.find((p) => GALLERY_DIR.test(p));
    return g ? { path: g, gallery: true } : { path: hits[0], gallery: false };
  };

  // 1. The best list of rows that name labels.
  let best: { rows: PyLit[][]; score: number } | null = null;
  for (const v of parsed) {
    if (!isList(v)) continue;
    const rows = v.filter(isList);
    if (rows.length < 2 || rows.length < v.length * 0.8) continue;
    const width = Math.max(...rows.map((r) => r.length));
    let labelHits = 0;
    for (let c = 0; c < width; c++) labelHits = Math.max(labelHits, rows.filter((r) => typeof r[c] === 'string' && inp.labels.has(r[c] as string)).length);
    const score = labelHits / rows.length;
    if (score >= 0.6 && (!best || labelHits > best.score)) best = { rows, score: labelHits };
  }

  const replays: ReplayInfo[] = [];
  const groupOrder: string[] = [];
  if (best) {
    const { rows } = best;
    const width = Math.max(...rows.map((r) => r.length));
    const frac = (c: number, pred: (v: PyLit | undefined) => boolean) => rows.filter((r) => pred(r[c])).length / rows.length;
    const cols = Array.from({ length: width }, (_, c) => c);
    const labelCol = cols.reduce((a, c) => (frac(c, (v) => typeof v === 'string' && inp.labels.has(v)) > frac(a, (v) => typeof v === 'string' && inp.labels.has(v)) ? c : a), 0);
    // Thumbnail: images in a gallery folder count double.
    const thumbScore = (c: number) =>
      rows.reduce((n, r) => {
        const s = text(r[c]);
        const hit = s ? imageFor(s) : null;
        return n + (hit ? (hit.gallery ? 2 : 1) : 0);
      }, 0);
    const thumbCol = cols.filter((c) => thumbScore(c) > 0).sort((a, b) => thumbScore(b) - thumbScore(a) || a - b)[0];
    // Title: translated strings first, else strings with spaces that aren't labels or images.
    const titleCol =
      cols.find((c) => frac(c, (v) => !!v && typeof v === 'object' && 'tr' in v) >= 0.6) ??
      cols.find((c) => c !== labelCol && c !== thumbCol && frac(c, (v) => typeof v === 'string' && /\s/.test(v) && !inp.labels.has(v)) >= 0.6);
    // Who: the list-of-names column that best matches characters or a name dict.
    const listCols = cols.filter((c) => frac(c, (v) => isList(v) && v.every((x) => typeof x === 'string')) >= 0.6);
    const whoScore = (c: number) => {
      const keys = [...new Set(rows.flatMap((r) => (isList(r[c]) ? (r[c] as PyLit[]).filter((x): x is string => typeof x === 'string') : [])))];
      if (!keys.length) return 0;
      const names = groupNames(dicts, keys);
      // Matching real characters is what counts; a name dict alone (tag lists have one too) barely does.
      const chars = keys.filter((k) => matchCharacter(k, names.get(k), inp.characters)).length;
      return chars / keys.length + (keys.filter((k) => names.has(k)).length / keys.length) * 0.01;
    };
    const whoCol = listCols.sort((a, b) => whoScore(b) - whoScore(a))[0];
    const useWho = whoCol !== undefined && whoScore(whoCol) >= 0.4;

    for (const r of rows) {
      const label = r[labelCol];
      if (typeof label !== 'string' || !inp.labels.has(label)) continue;
      const thumbName = thumbCol !== undefined ? text(r[thumbCol]) : null;
      const groups = useWho && isList(r[whoCol]) ? (r[whoCol] as PyLit[]).filter((x): x is string => typeof x === 'string') : [];
      for (const g of groups) if (!groupOrder.includes(g)) groupOrder.push(g);
      replays.push({
        label,
        title: (titleCol !== undefined ? text(r[titleCol])?.replace(/\{[^}]*\}/g, '').trim() : null) || inp.formatTitle(label),
        thumb: (thumbName && imageFor(thumbName)?.path) ?? null,
        groups,
        chars: [],
        scene: inp.sceneOf(label),
      });
    }
  }

  // 2. Literal Replay("label") buttons (on their own, or adding to a list).
  for (const b of inp.buttons) {
    if (!inp.labels.has(b.label) || replays.some((r) => r.label === b.label)) continue;
    const img = b.image ? (inp.resolveImage(b.image) ?? imageFor(b.image)?.path ?? null) : null;
    replays.push({ label: b.label, title: b.text?.replace(/\{[^}]*\}/g, '').trim() || inp.formatTitle(b.label), thumb: img, groups: [], chars: [], scene: inp.sceneOf(b.label) });
  }
  if (!replays.length) return undefined;

  // Groups: the game's order where it has a dict listing them, else first appearance.
  const names = groupNames(dicts, groupOrder);
  const dictOrder = [...names.keys()].filter((k) => groupOrder.includes(k));
  const ordered = [...dictOrder, ...groupOrder.filter((k) => !dictOrder.includes(k))];
  const groups = ordered.map((key) => {
    const name = names.get(key) ?? key.charAt(0).toUpperCase() + key.slice(1);
    return { key, name, char: matchCharacter(key, name, inp.characters) };
  });
  const charOf = new Map(groups.map((g) => [g.key, g.char]));
  for (const r of replays) r.chars = [...new Set(r.groups.map((g) => charOf.get(g)).filter((c): c is string => !!c))];
  return { replays, groups };
}
