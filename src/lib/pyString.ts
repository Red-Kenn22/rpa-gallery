/**
 * Small, forgiving helpers for reading Python source snippets that appear in
 * Ren'Py ASTs (PyCode sources, define/image expressions, ATL) and in .rpy
 * files. This is not a Python parser — just enough lexing to find string
 * literals and split call arguments correctly.
 */

export interface StringLiteral {
  value: string;
  start: number;
  end: number;
}

const PREFIX_CHARS = new Set(['r', 'R', 'b', 'B', 'u', 'U', 'f', 'F']);

function isWordChar(c: string | undefined): boolean {
  return c !== undefined && /[\w]/.test(c);
}

/** Decodes the body of a Python string literal (escapes only when not raw). */
export function unescapePython(body: string, raw = false): string {
  if (raw || body.indexOf('\\') < 0) return body;
  let out = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c !== '\\' || i + 1 >= body.length) {
      out += c;
      continue;
    }
    const e = body[++i];
    switch (e) {
      case '\n': break;
      case 'n': out += '\n'; break;
      case 't': out += '\t'; break;
      case 'r': out += '\r'; break;
      case '\\': out += '\\'; break;
      case "'": out += "'"; break;
      case '"': out += '"'; break;
      case 'a': out += '\x07'; break;
      case 'b': out += '\b'; break;
      case 'f': out += '\f'; break;
      case 'v': out += '\v'; break;
      case '0': out += '\0'; break;
      case 'x': {
        const h = body.substr(i + 1, 2);
        if (/^[0-9a-fA-F]{2}$/.test(h)) { out += String.fromCharCode(parseInt(h, 16)); i += 2; }
        else out += '\\x';
        break;
      }
      case 'u':
      case 'U': {
        const n = e === 'u' ? 4 : 8;
        const h = body.substr(i + 1, n);
        if (new RegExp(`^[0-9a-fA-F]{${n}}$`).test(h)) { out += String.fromCodePoint(parseInt(h, 16)); i += n; }
        else out += '\\' + e;
        break;
      }
      default: out += '\\' + e;
    }
  }
  return out;
}

/**
 * Finds every string literal in a Python snippet, skipping `#` comments.
 * Handles prefixes (r, u, b, f, rb…), single/double and triple quotes.
 */
export function findStringLiterals(src: string): StringLiteral[] {
  const out: StringLiteral[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '#') {
      const nl = src.indexOf('\n', i);
      i = nl < 0 ? src.length : nl + 1;
      continue;
    }
    if (c !== '"' && c !== "'") {
      i++;
      continue;
    }
    // Look back for a string prefix such as r / u / rb.
    let start = i;
    let raw = false;
    let j = i - 1;
    while (j >= 0 && i - j <= 2 && PREFIX_CHARS.has(src[j])) j--;
    if (j < i - 1 && !isWordChar(src[j])) {
      raw = /[rR]/.test(src.slice(j + 1, i));
      start = j + 1;
    }
    const triple = src.startsWith(c.repeat(3), i);
    const quote = triple ? c.repeat(3) : c;
    let k = i + quote.length;
    let closed = false;
    while (k < src.length) {
      if (src[k] === '\\') { k += 2; continue; }
      if (!triple && src[k] === '\n') break;
      if (src.startsWith(quote, k)) { closed = true; break; }
      k++;
    }
    if (!closed) {
      i = k + 1;
      continue;
    }
    const body = src.slice(i + quote.length, k);
    out.push({ value: unescapePython(body, raw), start, end: k + quote.length });
    i = k + quote.length;
  }
  return out;
}

/**
 * If `expr` is just a string literal — optionally wrapped in `_()` / `__()`,
 * or several adjacent literals — returns its value. Otherwise null.
 */
export function literalValue(expr: string | null | undefined): string | null {
  if (!expr) return null;
  let e = expr.trim();
  const wrap = /^_{1,3}\(\s*([\s\S]*)\)$/.exec(e);
  if (wrap) e = wrap[1].trim();
  if (!e || (e[0] !== '"' && e[0] !== "'" && !/^[rRuUbB]{1,2}["']/.test(e))) return null;
  const lits = findStringLiterals(e);
  if (!lits.length || lits[0].start !== 0) return null;
  let pos = 0;
  let value = '';
  for (const l of lits) {
    if (e.slice(pos, l.start).trim() !== '') return null;
    value += l.value;
    pos = l.end;
  }
  return e.slice(pos).trim() === '' ? value : null;
}

/** Splits `a, b=(1, 2), "x,y"` at top-level commas. */
export function splitTopLevel(src: string, sep = ','): string[] {
  const parts: string[] = [];
  let depth = 0;
  let last = 0;
  const lits = findStringLiterals(src);
  let li = 0;
  for (let i = 0; i < src.length; i++) {
    while (li < lits.length && lits[li].end <= i) li++;
    if (li < lits.length && i >= lits[li].start && i < lits[li].end) {
      i = lits[li].end - 1;
      continue;
    }
    const c = src[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === sep && depth === 0) {
      parts.push(src.slice(last, i));
      last = i + 1;
    }
  }
  parts.push(src.slice(last));
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

/** Index of the bracket matching the one at `open`, or -1. Skips strings and comments; stops at the match. */
export function matchBracket(src: string, open: number): number {
  const closers: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
  const stack: string[] = [];
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'") {
      const triple = src.startsWith(c.repeat(3), i);
      const q = triple ? c.repeat(3) : c;
      i += q.length;
      while (i < src.length && !src.startsWith(q, i)) i += src[i] === '\\' ? 2 : 1;
      i += q.length - 1;
      continue;
    }
    if (c === '#') {
      const nl = src.indexOf('\n', i);
      if (nl < 0) return -1;
      i = nl;
      continue;
    }
    if (closers[c]) stack.push(closers[c]);
    else if (c === ')' || c === ']' || c === '}') {
      if (stack.pop() !== c) return -1;
      if (stack.length === 0) return i;
    }
  }
  return -1;
}

export interface CallArgs {
  positional: string[];
  keyword: Record<string, string>;
}

export function parseCallArgs(argsText: string): CallArgs {
  const positional: string[] = [];
  const keyword: Record<string, string> = {};
  for (const part of splitTopLevel(argsText)) {
    const kw = /^([A-Za-z_]\w*)\s*=(?!=)\s*([\s\S]*)$/.exec(part);
    if (kw) keyword[kw[1]] = kw[2].trim();
    else positional.push(part);
  }
  return { positional, keyword };
}

/** Parses a call to `callee` starting exactly at `pos` (after optional whitespace), or null. */
export function callAt(src: string, pos: number, callee: RegExp): FoundCall | null {
  const re = new RegExp(`\\s*(${callee.source})\\s*\\(`, 'y');
  re.lastIndex = pos;
  const m = re.exec(src);
  if (!m) return null;
  const open = pos + m[0].length - 1;
  const close = matchBracket(src, open);
  if (close < 0) return null;
  return { callee: m[1], args: parseCallArgs(src.slice(open + 1, close)), start: pos + m[0].indexOf(m[1]), end: close + 1 };
}

export interface FoundCall {
  callee: string;
  args: CallArgs;
  start: number;
  end: number;
}

/** Finds calls whose callee matches `callee` (e.g. /(?:\w+\.)*Character/). */
export function findCalls(src: string, callee: RegExp): FoundCall[] {
  const out: FoundCall[] = [];
  // No lookbehind: iOS Safari < 16.4 lacks it.
  const re = new RegExp(`(^|[^\\w.])(${callee.source})\\s*\\(`, 'g');
  const lits = findStringLiterals(src);
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const at = m.index + m[1].length;
    if (lits.some((l) => at >= l.start && at < l.end)) continue;
    const open = m.index + m[0].length - 1;
    const close = matchBracket(src, open);
    if (close < 0) continue;
    out.push({ callee: m[2], args: parseCallArgs(src.slice(open + 1, close)), start: at, end: close + 1 });
    re.lastIndex = open + 1;
  }
  return out;
}

/** Removes Ren'Py text tags like {b}, {color=#f00}, {w=0.5}; keeps {{ escapes. */
export function stripTextTags(s: string): string {
  return s.replace(/\{\{/g, '\u0000').replace(/\{[^{}]*\}/g, '').replace(/\u0000/g, '{');
}
