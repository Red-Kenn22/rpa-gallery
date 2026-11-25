/**
 * Scans parsed scripts for things the diagnostics report wants but the scene
 * builder ignores: screen definitions and replay / gallery code.
 */
import { PyObject } from './pickle';
import type { IndexDiagnostics } from '../types';

const REPLAY_RE = /\b(?:Replay\s*\(|call_replay\b|Gallery\s*\(|\.unlock_image\s*\(|\.unlock\s*\(|\.condition\s*\()/;
const MAX_REPLAY = 400;
const MAX_SCREENS = 400;
const MAX_TEXT = 240;
/** Upper bound on values visited per file, so a pathological pickle can't stall indexing. */
const MAX_VISITS = 1_500_000;

export class DiagCollector {
  readonly screens: IndexDiagnostics['screens'] = [];
  readonly replay: IndexDiagnostics['replay'] = [];
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
    }
  }
}
