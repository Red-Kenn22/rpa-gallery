/**
 * Fallback parser for plain-text Ren'Py scripts (.rpy / .rpym).
 *
 * Used when an archive ships sources without compiled .rpyc files, or a .rpyc
 * can't be read. It recognises the statements the gallery needs and skips
 * everything else; it never has to be a complete Ren'Py parser.
 */

import { findStringLiterals } from './pyString';
import type { Stmt } from './scriptModel';

interface Line {
  indent: number;
  text: string;
  line: number;
  children: Line[];
}

/** Joins continuation lines (open brackets, triple quotes, trailing `\`) and strips comments. */
function logicalLines(src: string): Omit<Line, 'children'>[] {
  const rawLines = src.replace(/^﻿/, '').replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n');
  const out: Omit<Line, 'children'>[] = [];
  let buf = '';
  let startLine = 0;
  let indent = 0;
  let depth = 0;
  let triple: string | null = null;

  for (let n = 0; n < rawLines.length; n++) {
    const raw = rawLines[n];
    if (!buf) {
      if (!raw.trim()) continue;
      indent = raw.length - raw.trimStart().length;
      startLine = n + 1;
    }
    // Scan for brackets / strings / comments.
    let text = '';
    for (let i = buf ? 0 : indent; i < raw.length; i++) {
      const c = raw[i];
      if (triple) {
        if (raw.startsWith(triple, i)) {
          text += triple;
          i += 2;
          triple = null;
        } else {
          if (c === '\\') { text += raw.slice(i, i + 2); i++; continue; }
          text += c;
        }
        continue;
      }
      if (c === '#') break;
      if (c === '"' || c === "'") {
        if (raw.startsWith(c.repeat(3), i)) {
          triple = c.repeat(3);
          text += triple;
          i += 2;
          continue;
        }
        let k = i + 1;
        while (k < raw.length && raw[k] !== c) k += raw[k] === '\\' ? 2 : 1;
        text += raw.slice(i, k + 1);
        i = k;
        continue;
      }
      if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' || c === ']' || c === '}') depth = Math.max(0, depth - 1);
      text += c;
    }
    let continued = depth > 0 || triple !== null;
    if (!continued && text.trimEnd().endsWith('\\')) {
      text = text.trimEnd().slice(0, -1);
      continued = true;
    }
    buf += (buf ? (triple ? '\n' : ' ') : '') + (buf ? text.trim() : text);
    if (!continued) {
      if (buf.trim()) out.push({ indent, text: buf.trim(), line: startLine });
      buf = '';
    }
  }
  if (buf.trim()) out.push({ indent, text: buf.trim(), line: startLine });
  return out;
}

/** Nests lines by indentation under the line that ends with ':'. */
function buildTree(lines: Omit<Line, 'children'>[]): Line[] {
  const root: Line = { indent: -1, text: '', line: 0, children: [] };
  const stack: Line[] = [root];
  for (const l of lines) {
    const node: Line = { ...l, children: [] };
    while (stack.length > 1 && stack[stack.length - 1].indent >= l.indent) stack.pop();
    stack[stack.length - 1].children.push(node);
    stack.push(node);
  }
  return root.children;
}

function flattenSource(lines: Line[], baseIndent: number): string {
  const out: string[] = [];
  const visit = (ls: Line[]) => {
    for (const l of ls) {
      out.push(' '.repeat(Math.max(0, l.indent - baseIndent)) + l.text);
      visit(l.children);
    }
  };
  visit(lines);
  return out.join('\n');
}

function allLiterals(lines: Line[]): string[] {
  return findStringLiterals(flattenSource(lines, 0)).map((l) => l.value);
}

const CLAUSE_WORDS = new Set(['at', 'as', 'behind', 'onlayer', 'with', 'zorder', 'expression']);
const KEYWORDS = new Set([
  'label', 'init', 'python', 'define', 'default', 'image', 'scene', 'show', 'hide', 'with', 'jump', 'call',
  'return', 'pass', 'menu', 'if', 'elif', 'else', 'while', 'for', 'play', 'queue', 'stop', 'voice', 'pause',
  'window', 'nvl', 'screen', 'transform', 'style', 'translate', 'camera', 'layeredimage', 'testcase', 'rpy',
  'early', 'old', 'new', 'config', 'achievement',
]);

const IDENT = /^[A-Za-z_][\w.]*/;

/** Reads a leading Python string literal (with optional prefix). */
function leadingLiteral(s: string): { raw: string; value: string; rest: string } | null {
  if (!/^[rRuUbBfF]{0,2}["']/.test(s)) return null;
  const lits = findStringLiterals(s);
  if (!lits.length || lits[0].start !== 0) return null;
  return { raw: s.slice(0, lits[0].end), value: lits[0].value, rest: s.slice(lits[0].end).trimStart() };
}

function parseSay(text: string): { who: string | null; what: string } | null {
  const first = leadingLiteral(text);
  if (first) {
    const second = leadingLiteral(first.rest);
    if (second) return { who: first.raw, what: second.value };
    return { who: null, what: first.value };
  }
  const id = IDENT.exec(text);
  if (!id || KEYWORDS.has(id[0])) return null;
  let rest = text.slice(id[0].length).trimStart();
  // Image attributes between speaker and line: `e happy -sad @ surprised "Hi"`
  for (let guard = 0; guard < 12 && rest; guard++) {
    const lit = leadingLiteral(rest);
    if (lit) return { who: id[0], what: lit.value };
    const word = /^[-@]?\s*[\w]+/.exec(rest);
    if (!word) return null;
    rest = rest.slice(word[0].length).trimStart();
  }
  return null;
}

function parseImageClause(rest: string): { name: string[]; expr: string | null } {
  const r = rest.replace(/:$/, '').trim();
  const exprMatch = /^expression\s+([\s\S]+?)(?:\s+(?:at|as|behind|onlayer|with|zorder)\s[\s\S]*)?$/.exec(r);
  if (exprMatch) return { name: [], expr: exprMatch[1].trim() };
  const name: string[] = [];
  for (const tok of r.split(/\s+/)) {
    if (!tok || CLAUSE_WORDS.has(tok)) break;
    name.push(tok);
  }
  return { name, expr: null };
}

class RpyConverter {
  convert(lines: Line[], out: Stmt[]): void {
    for (const l of lines) this.line(l, out);
  }

  private line(l: Line, out: Stmt[]): void {
    const t = l.text;
    const head = /^[A-Za-z_$]+/.exec(t)?.[0] ?? (t.startsWith('$') ? '$' : '');

    if (t.startsWith('$')) {
      out.push({ k: 'python', source: t.slice(1).trim(), line: l.line });
      return;
    }

    switch (head) {
      case 'label': {
        const m = /^label\s+([\w.]+)/.exec(t);
        if (!m) return;
        const body: Stmt[] = [];
        this.convert(l.children, body);
        out.push({ k: 'label', name: m[1], line: l.line, body });
        return;
      }
      case 'init':
      case 'python': {
        if (/\bpython\b/.test(t)) {
          out.push({ k: 'python', source: flattenSource(l.children, l.children[0]?.indent ?? 0), line: l.line });
        } else {
          // `init:` / `init -1:` – may contain `$` lines, defines, images
          const rest = t.replace(/^init\s*-?\d*\s*/, '');
          if (rest && rest !== ':') this.line({ ...l, text: rest }, out);
          else this.convert(l.children, out);
        }
        return;
      }
      case 'define': {
        const m = /^define\s+(?:-?\d+\s+)?([\w.]+)\s*(?:\+|\|)?=\s*([\s\S]+)$/.exec(t);
        if (!m) return;
        const parts = m[1].split('.');
        const name = parts.pop()!;
        const store = ['store', ...parts.filter((p) => p !== 'store')].join('.');
        out.push({ k: 'define', store, name, source: m[2].trim(), line: l.line });
        return;
      }
      case 'image': {
        const assign = /^image\s+([^=:]+?)\s*=\s*([\s\S]+)$/.exec(t);
        if (assign) {
          out.push({ k: 'image', name: assign[1].trim().split(/\s+/), source: assign[2].trim(), atl: [], line: l.line });
          return;
        }
        const atl = /^image\s+([^=:]+?)\s*:$/.exec(t);
        if (atl) out.push({ k: 'image', name: atl[1].trim().split(/\s+/), source: null, atl: allLiterals(l.children), line: l.line });
        return;
      }
      case 'scene': {
        const rest = t.slice(5).trim();
        if (/^(?:onlayer\b|with\b|:)/.test(rest) || !rest) {
          out.push({ k: 'scene', name: null, expr: null, line: l.line });
          return;
        }
        const spec = parseImageClause(rest);
        out.push({ k: 'scene', name: spec.name.length ? spec.name : null, expr: spec.expr, line: l.line });
        return;
      }
      case 'show': {
        const rest = t.slice(4).trim();
        if (/^(?:screen|layer)\b/.test(rest)) return;
        const spec = parseImageClause(rest);
        if (spec.name.length || spec.expr) out.push({ k: 'show', name: spec.name, expr: spec.expr, line: l.line });
        return;
      }
      case 'play':
      case 'queue':
        out.push({ k: 'user', text: t, line: l.line });
        return;
      case 'jump':
      case 'call': {
        const m = /^(jump|call)\s+(?!expression\b)([\w.]+)/.exec(t);
        if (m) out.push({ k: m[1] as 'jump' | 'call', target: m[2], line: l.line });
        return;
      }
      case 'if':
      case 'elif':
      case 'else':
      case 'while':
      case 'for':
        this.convert(l.children, out);
        return;
      case 'menu': {
        const choices: string[] = [];
        const inner: Stmt[] = [];
        for (const c of l.children) {
          const lit = leadingLiteral(c.text);
          if (lit && c.children.length) {
            choices.push(lit.value);
            this.convert(c.children, inner);
          } else {
            this.line(c, out); // narration caption (shown before the choices), `set`, etc.
          }
        }
        if (choices.length) out.push({ k: 'menu', choices, line: l.line });
        out.push(...inner);
        return;
      }
      case 'translate': {
        const m = /^translate\s+(\w+)\s+\w+\s*:$/.exec(t);
        if (m && m[1] === 'None') this.convert(l.children, out);
        return;
      }
      default:
        break;
    }

    if (KEYWORDS.has(head)) return;
    const say = parseSay(t);
    if (say) out.push({ k: 'say', who: say.who, what: say.what, line: l.line });
  }
}

export function parseRpy(source: string): Stmt[] {
  const out: Stmt[] = [];
  new RpyConverter().convert(buildTree(logicalLines(source)), out);
  return out;
}

/** Exposed for tests. */
export const _internal = { logicalLines, parseSay };
