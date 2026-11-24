/**
 * Converts unpickled renpy.ast.* trees into the flat `Stmt` model.
 *
 * Tolerant of every AST layout from Ren'Py 6 to 8.x:
 *   – plain `__dict__` objects (Ren'Py 6/7 renpy.object.Object)
 *   – `__slots__` / cslots state `(None, {slots})` (Ren'Py 7.4+/8.x)
 *   – slots omitted when they hold their default value (cslots)
 *   – Say wrapped in Translate (6.15–8.0) or merged into TranslateSay (8.1+)
 *   – PyCode state tuples of 4–7 items, PyExpr collapsed to strings
 *
 * Only container blocks are followed; `next` chains are ignored, so the walk is
 * linear in the size of the script.
 */

import { PyObject, pyStr } from './pickle';
import { literalValue } from './pyString';
import type { Stmt } from './scriptModel';

const MAX_DEPTH = 200;

function attr(node: PyObject, name: string): unknown {
  return node.attrs.get(name);
}

function str(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === 'string') return v;
  if (v instanceof Uint8Array) return pyStr(v);
  if (typeof v === 'number' || typeof v === 'bigint') return String(v);
  return null;
}

function lineOf(node: PyObject): number {
  const l = attr(node, 'linenumber');
  return typeof l === 'number' ? l : 0;
}

function strTuple(v: unknown): string[] {
  if (!Array.isArray(v)) return typeof v === 'string' ? v.split(/\s+/).filter(Boolean) : [];
  return v.map((x) => str(x)).filter((x): x is string => x !== null && x !== '');
}

/** Source text of a renpy.ast.PyCode (or a bare string / PyExpr). */
export function pyCodeSource(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === 'string') return v;
  if (v instanceof PyObject) {
    // PyCode.__getstate__: (1, source, location, mode[, py[, hashcode[, col_offset]]])
    if (Array.isArray(v.state) && v.state.length >= 2) return str(v.state[1]);
    const s = v.attrs.get('source');
    if (s != null) return str(s);
    if (v.args.length) return str(v.args[0]);
  }
  return null;
}

/** Collects quoted string literals from an ATL block (RawBlock / RawMultipurpose …). */
export function atlLiterals(atl: unknown, limit = 64): string[] {
  const out: string[] = [];
  const seen = new Set<unknown>();
  const stack: unknown[] = [atl];
  while (stack.length && out.length < limit) {
    const v = stack.pop();
    if (v == null || seen.has(v)) continue;
    if (typeof v === 'string') {
      const lit = literalValue(v);
      if (lit !== null) out.push(lit);
      continue;
    }
    if (typeof v !== 'object') continue;
    seen.add(v);
    if (Array.isArray(v)) {
      for (let i = v.length - 1; i >= 0; i--) stack.push(v[i]);
    } else if (v instanceof Map) {
      for (const x of v.values()) stack.push(x);
    } else if (v instanceof PyObject) {
      for (const [k, x] of v.attrs) if (k !== 'loc' && k !== 'filename') stack.push(x);
      stack.push(v.args, v.state, v.listItems);
    }
  }
  return out.reverse();
}

interface Imspec {
  name: string[];
  expr: string | null;
  at: string[];
}

/** imspec: (name, at_list, layer) or (name, expression, tag, at_list, layer, zorder[, behind]). */
function readImspec(v: unknown): Imspec | null {
  if (!Array.isArray(v) || v.length === 0) return null;
  const name = strTuple(v[0]);
  const long = v.length >= 6;
  const expr = long ? pyCodeSource(v[1]) : null;
  const atRaw = long ? v[3] : v[1];
  const at = Array.isArray(atRaw) ? atRaw.map((a) => pyCodeSource(a)).filter((a): a is string => !!a) : [];
  if (!name.length && !expr) return null;
  return { name, expr, at };
}

function isNullLanguage(node: PyObject): boolean {
  const lang = attr(node, 'language');
  return lang == null;
}

export class AstWalker {
  /** Class names we met but don't handle — handy for debugging new Ren'Py versions. */
  readonly unknownClasses = new Set<string>();

  walk(stmts: unknown): Stmt[] {
    const out: Stmt[] = [];
    this.block(stmts, out, 0);
    return out;
  }

  private sub(block: unknown, depth: number): Stmt[] {
    const out: Stmt[] = [];
    this.block(block, out, depth);
    return out;
  }

  private block(block: unknown, out: Stmt[], depth: number): void {
    if (depth > MAX_DEPTH) return;
    const items = Array.isArray(block) ? block : block instanceof PyObject && block.listItems ? block.listItems : null;
    if (!items) return;
    for (const node of items) {
      if (node instanceof PyObject) this.node(node, out, depth + 1);
    }
  }

  private node(node: PyObject, out: Stmt[], depth: number): void {
    const cls = node.cls.name;
    const line = lineOf(node);

    switch (cls) {
      case 'Label': {
        const name = str(attr(node, 'name'));
        const body: Stmt[] = [];
        this.block(attr(node, 'block'), body, depth);
        if (name) out.push({ k: 'label', name, line, body });
        else out.push(...body);
        return;
      }

      case 'Say':
      case 'TranslateSay': {
        if (cls === 'TranslateSay' && !isNullLanguage(node)) return;
        const what = str(attr(node, 'what'));
        if (what === null) return;
        out.push({ k: 'say', who: str(attr(node, 'who')), what, line });
        return;
      }

      case 'Init':
        this.block(attr(node, 'block'), out, depth);
        return;

      case 'While':
        out.push({ k: 'while', cond: pyCodeSource(attr(node, 'condition')) ?? 'True', body: this.sub(attr(node, 'block'), depth), line });
        return;

      case 'Return':
        out.push({ k: 'return', line });
        return;

      case 'Translate':
        if (isNullLanguage(node)) this.block(attr(node, 'block'), out, depth);
        return;

      case 'If': {
        const entries = attr(node, 'entries');
        if (!Array.isArray(entries)) return;
        const list = entries
          .filter((e): e is unknown[] => Array.isArray(e))
          .map((e) => ({ cond: pyCodeSource(e[0]) ?? 'True', body: this.sub(e[1], depth) }));
        if (list.length) out.push({ k: 'if', entries: list, line });
        return;
      }

      case 'Menu': {
        const items = attr(node, 'items');
        if (!Array.isArray(items)) return;
        const choices: { text: string; cond: string | null; body: Stmt[] }[] = [];
        for (const it of items) {
          if (!Array.isArray(it)) continue;
          const caption = str(it[0]);
          if (it[2] != null && caption !== null) {
            const cond = pyCodeSource(it[1]);
            choices.push({ text: caption, cond: cond && cond !== 'True' ? cond : null, body: this.sub(it[2], depth) });
          } else if (caption) {
            out.push({ k: 'say', who: null, what: caption, line }); // narration caption
          }
        }
        if (choices.length) out.push({ k: 'menu', choices, line });
        return;
      }

      case 'Scene': {
        const spec = readImspec(attr(node, 'imspec'));
        out.push({ k: 'scene', name: spec?.name.length ? spec.name : null, expr: spec?.expr ?? null, at: spec?.at ?? [], line });
        return;
      }

      case 'Show': {
        const spec = readImspec(attr(node, 'imspec'));
        if (spec) out.push({ k: 'show', name: spec.name, expr: spec.expr, at: spec.at, line });
        return;
      }

      case 'Hide': {
        const spec = readImspec(attr(node, 'imspec'));
        if (spec?.name.length) out.push({ k: 'hide', name: spec.name, line });
        return;
      }

      case 'Python':
      case 'EarlyPython': {
        const source = pyCodeSource(attr(node, 'code'));
        if (source) out.push({ k: 'python', source, line });
        return;
      }

      case 'Define': {
        const name = str(attr(node, 'varname'));
        const source = pyCodeSource(attr(node, 'code'));
        if (name && source) {
          out.push({ k: 'define', store: str(attr(node, 'store')) ?? 'store', name, source, line });
        }
        return;
      }

      case 'Image': {
        const name = strTuple(attr(node, 'imgname'));
        if (!name.length) return;
        const source = pyCodeSource(attr(node, 'code'));
        const atl = source ? [] : atlLiterals(attr(node, 'atl'));
        out.push({ k: 'image', name, source, atl, line });
        return;
      }

      case 'UserStatement': {
        const text = str(attr(node, 'line'));
        if (text) out.push({ k: 'user', text, line });
        this.block(attr(node, 'block'), out, depth);
        const subs = attr(node, 'subparses');
        if (Array.isArray(subs)) {
          for (const sp of subs) if (sp instanceof PyObject) this.block(sp.attrs.get('block'), out, depth);
        }
        return;
      }

      case 'Jump':
      case 'Call': {
        if (attr(node, 'expression')) return;
        const target = str(attr(node, cls === 'Jump' ? 'target' : 'label'));
        if (target) out.push({ k: cls === 'Jump' ? 'jump' : 'call', target, line });
        return;
      }

      // Nothing to extract.
      case 'With':
      case 'Pass':
      case 'ShowLayer':
      case 'Camera':
      case 'Default':
      case 'Transform':
      case 'Screen':
      case 'Style':
      case 'Testcase':
      case 'RPY':
      case 'EndTranslate':
      case 'TranslateBlock':
      case 'TranslateEarlyBlock':
      case 'TranslateString':
      case 'TranslatePython':
        return;

      default:
        this.unknownClasses.add(node.cls.qualifiedName);
        // Forward compatibility: descend into anything that has a block.
        this.block(attr(node, 'block'), out, depth);
    }
  }
}
