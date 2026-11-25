/**
 * Scans parsed scripts for things the diagnostics report wants but the scene
 * builder ignores: screen definitions and replay / gallery code.
 */
import { PyObject } from './pickle';
import type { IndexDiagnostics } from '../types';
import { literalValue } from './pyString';
import type { ReplayButton } from './replayGallery';

const REPLAY_LABEL = /\bReplay\s*\(\s*(u?["'][^"']+["'])/;

const REPLAY_RE = /\b(?:Replay\s*\(|call_replay\b|Gallery\s*\(|\.unlock_image\s*\(|\.unlock\s*\(|\.condition\s*\()/;
const MAX_REPLAY = 400;
const MAX_SCREENS = 400;
const MAX_TEXT = 240;
/** Upper bound on values visited per file, so a pathological pickle can't stall indexing. */
const MAX_VISITS = 1_500_000;

/** Files whose code (outside labels and dialogue) is kept whole: gallery/replay/bio definitions. */
const CODE_FILE = /gallery|replay|bios?\b|bios?[_.]|unlock|achievement/i;
const MAX_CODE_STRINGS = 1500;
const MAX_CODE_CHARS = 60_000;
/** Statement classes whose contents are story, not gallery setup. */
const SKIP_IN_CODE = new Set(['Label', 'Say', 'TranslateSay', 'Translate', 'TranslateBlock']);

export class DiagCollector {
  readonly screens: IndexDiagnostics['screens'] = [];
  readonly replay: IndexDiagnostics['replay'] = [];
  readonly code: NonNullable<IndexDiagnostics['code']> = [];
  /** Screen buttons whose action is Replay("literal label"). */
  readonly buttons: ReplayButton[] = [];

  /** An SLDisplayable with `action Replay("x")`: its label, image and text. */
  private replayButton(node: PyObject) {
    const kw = node.get('keyword');
    if (!Array.isArray(kw)) return;
    const pairs = kw.filter((p): p is [string, string] => Array.isArray(p) && typeof p[0] === 'string' && typeof p[1] === 'string');
    const action = pairs.find(([k]) => k === 'action')?.[1];
    const m = action ? REPLAY_LABEL.exec(action) : null;
    const label = m ? literalValue(m[1]) : null;
    if (!label) return;
    const imgExpr = pairs.find(([k]) => k === 'idle' || k === 'ground' || k === 'auto')?.[1];
    const pos = node.get('positional');
    const first = Array.isArray(pos) && typeof pos[0] === 'string' ? literalValue(pos[0]) : null;
    const image = imgExpr ? literalValue(imgExpr) : node.get('displayable') === 'imagebutton' ? first : null;
    const text = node.get('displayable') === 'textbutton' ? first : null;
    const b: ReplayButton = { label };
    if (image) b.image = image.replace('%s', 'idle');
    if (text) b.text = text;
    this.buttons.push(b);
  }
  private seen = new Set<string>();

  private addLines(file: string, text: string, screen?: string) {
    if (!REPLAY_RE.test(text)) return;
    for (const raw of text.split('\n')) {
      if (this.replay.length >= MAX_REPLAY) return;
      const line = raw.trim();
      if (!line || !REPLAY_RE.test(line)) continue;
      const clipped = line.length > MAX_TEXT ? `${line.slice(0, MAX_TEXT)}…` : line;
      const key = `${file}\n${screen ?? ''}\n${clipped}`;
      if (this.seen.has(key)) continue;
      this.seen.add(key);
      this.replay.push(screen ? { file, screen, text: clipped } : { file, text: clipped });
    }
  }

  /** Walks a raw unpickled .rpyc statement tree. */
  scanTree(file: string, root: unknown) {
    if (CODE_FILE.test(file)) this.captureCode(file, root);
    const visited = new Set<object>();
    let visits = 0;
    // Explicit stack (with the enclosing screen name) instead of recursion: trees can be deep.
    const stack: [unknown, string | undefined][] = [[root, undefined]];
    while (stack.length && visits < MAX_VISITS) {
      const [v, screen] = stack.pop()!;
      visits++;
      if (typeof v === 'string') {
        this.addLines(file, v, screen);
        continue;
      }
      if (!v || typeof v !== 'object' || visited.has(v)) continue;
      visited.add(v);
      if (Array.isArray(v)) {
        for (let i = v.length - 1; i >= 0; i--) stack.push([v[i], screen]);
      } else if (v instanceof Map) {
        for (const [k, x] of v) stack.push([k, screen], [x, screen]);
      } else if (v instanceof Set) {
        for (const x of v) stack.push([x, screen]);
      } else if (v instanceof PyObject) {
        let inner = screen;
        if (v.cls.name === 'SLDisplayable') this.replayButton(v);
        if (v.cls.name === 'SLScreen') {
          const name = v.get('name');
          if (typeof name === 'string') {
            inner = name;
            if (this.screens.length < MAX_SCREENS) this.screens.push({ name, file });
          }
        }
        for (const x of v.attrs.values()) stack.push([x, inner]);
        stack.push([v.args, inner], [v.state, inner]);
        if (v.kwargs) stack.push([v.kwargs, inner]);
        if (v.listItems) stack.push([v.listItems, inner]);
        if (v.dictItems) stack.push([v.dictItems, inner]);
      }
    }
  }

  /** Keeps every string of a gallery-ish file outside labels and dialogue, in order, with screen markers. */
  private captureCode(file: string, root: unknown) {
    const entry = { file, strings: [] as string[], truncated: false };
    const seen = new Set<string>();
    let chars = 0;
    const visited = new Set<object>();
    const stack: unknown[] = [root];
    let visits = 0;
    while (stack.length && visits++ < MAX_VISITS) {
      const v = stack.pop();
      if (typeof v === 'string') {
        const t = v.trim();
        if (!t || seen.has(t)) continue;
        if (entry.strings.length >= MAX_CODE_STRINGS || chars + t.length > MAX_CODE_CHARS) {
          entry.truncated = true;
          break;
        }
        seen.add(t);
        chars += t.length;
        entry.strings.push(t);
        continue;
      }
      if (!v || typeof v !== 'object' || visited.has(v)) continue;
      visited.add(v);
      // Children are pushed in reverse so they pop in source order.
      if (Array.isArray(v)) {
        for (let i = v.length - 1; i >= 0; i--) stack.push(v[i]);
      } else if (v instanceof Map) {
        const items = [...v].flat();
        for (let i = items.length - 1; i >= 0; i--) stack.push(items[i]);
      } else if (v instanceof PyObject) {
        if (SKIP_IN_CODE.has(v.cls.name)) continue;
        const kids: unknown[] = [v.args, v.state, v.kwargs, v.listItems, v.dictItems, ...v.attrs.values()];
        for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
        if (v.cls.name === 'SLScreen' && typeof v.get('name') === 'string') stack.push(`«screen ${v.get('name') as string}»`);
      }
    }
    if (entry.strings.length) this.code.push(entry);
  }

  /** Scans .rpy source text (screen names from `screen x(...)` lines). */
  scanText(file: string, text: string) {
    let screen: string | undefined;
    let screenIndent = -1;
    for (const raw of text.split('\n')) {
      const indent = raw.length - raw.trimStart().length;
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      if (screen !== undefined && indent <= screenIndent) screen = undefined;
      const m = /^screen\s+([A-Za-z_]\w*)/.exec(line);
      if (m) {
        screen = m[1];
        screenIndent = indent;
        if (this.screens.length < MAX_SCREENS) this.screens.push({ name: screen, file });
        continue;
      }
      this.addLines(file, line, screen);
      const rm = REPLAY_LABEL.exec(line);
      const label = rm ? literalValue(rm[1]) : null;
      if (label) {
        const img = /\b(?:idle|ground|auto)\s+(u?["'][^"']+["'])/.exec(line);
        const txt = /^textbutton\s+(?:_\()?(u?["'][^"']+["'])/.exec(line);
        const b: ReplayButton = { label };
        const image = img ? literalValue(img[1]) : null;
        if (image) b.image = image.replace('%s', 'idle');
        const t = txt ? literalValue(txt[1]) : null;
        if (t) b.text = t;
        this.buttons.push(b);
      }
    }
  }
}
