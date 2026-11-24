/**
 * Compiles a label's statements into a flat list of player steps with
 * explicit jumps (menus and ifs become `menu`/`branch` + `goto`). Images and
 * speakers are resolved here, so the player only ever deals with archive
 * paths and character ids.
 */

import type { StagePos, Step, VarChange } from '../types';
import { findCalls, findStringLiterals, literalValue, stripTextTags } from './pyString';
import type { Stmt } from './scriptModel';
import { mediaKind } from './media';
import type { Registry } from './sceneParser';

const POSITIONS: Record<string, StagePos> = {
  left: [0, 1],
  right: [1, 1],
  center: [0.5, 1],
  truecenter: [0.5, 0.5],
  top: [0.5, 0],
  topleft: [0, 0],
  topright: [1, 0],
  midleft: [0, 0.5],
  midright: [1, 0.5],
};

export function positionFromAt(at: string[]): StagePos | null {
  for (const a of at) {
    const p = POSITIONS[a.trim()];
    if (p) return p;
  }
  return null;
}

const IGNORED_VARS = /^(?:config|gui|style|renpy|preferences|build|_|achievement|ui|layout)\b|^_/;
const IGNORED_CALLS = /^(?:renpy|store\.renpy|ui|config|gui|style|im|Transform|Character|Movie|Image|Solid|Composite|LiveComposite|ConditionSwitch|Dissolve|Fade|Pause|nvl_|hide_|show_|Show|Hide|Jump|Function|NullAction|Return|SetVariable|Play|Stop|Queue)\b|^(?:print|len|str|int|float|list|dict|set|range|min|max|abs|round|sorted|setattr|getattr|hasattr|isinstance|super|type)$/;

/**
 * Simple variable changes in Python code: `x += 1`, `lucy.love -= 2`,
 * `met = True`, plus bare game-function calls like `add_points("lucy", 2)`.
 */
export function parseAssignments(source: string): VarChange[] {
  const out: VarChange[] = [];
  for (const raw of source.split(/\n|;/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^((?:store\.)?[A-Za-z_][\w]*(?:\.[A-Za-z_]\w*)*(?:\[[^\]]+\])?)\s*(\+=|-=|=)(?!=)\s*(.+)$/.exec(line);
    if (m) {
      const v = m[1].replace(/^store\./, '');
      const val = m[3].trim();
      if (IGNORED_VARS.test(v) || /\bCharacter\s*\(|\b(?:renpy|Movie|Transform|im)\./.test(val)) continue;
      if (m[2] === '=' && /\(/.test(val) && !/^(?:int|float|str|bool|min|max)\(/.test(val)) continue;
      out.push({ v, op: m[2] as VarChange['op'], val: val.length > 40 ? `${val.slice(0, 39)}…` : val });
      continue;
    }
    const call = /^([A-Za-z_][\w.]*)\s*\((.*)\)\s*$/.exec(line);
    if (call && !IGNORED_CALLS.test(call[1]) && !call[1].startsWith('_')) {
      out.push({ v: call[1], op: 'call', val: line.length > 48 ? `${line.slice(0, 47)}…` : line });
    }
  }
  return out.slice(0, 8);
}

interface PyEvent {
  at: number;
  step: Step;
}

/** Player-relevant calls inside Python code, in source order. */
function pythonSteps(source: string, reg: Registry): Step[] {
  const changes = parseAssignments(source);
  const setStep: Step[] = changes.length ? [{ t: 'set', changes }] : [];
  if (!/renpy\.|Movie/.test(source)) return setStep;
  const events: PyEvent[] = [];
  for (const c of findCalls(source, /renpy\.(?:pause|movie_cutscene|show|scene|jump|call)/)) {
    const arg = literalValue(c.args.positional[0]);
    switch (c.callee) {
      case 'renpy.pause':
        events.push({ at: c.start, step: { t: 'pause' } });
        break;
      case 'renpy.movie_cutscene':
        if (arg) events.push({ at: c.start, step: { t: 'video', img: reg.resolveFile(arg), name: arg } });
        break;
      case 'renpy.show':
        if (arg) {
          const tokens = arg.split(/\s+/);
          events.push({ at: c.start, step: { t: 'show', tag: tokens[0], img: reg.resolveImage(tokens), name: arg, pos: null } });
        }
        break;
      case 'renpy.scene':
        events.push({ at: c.start, step: { t: 'bg', img: null, name: null, tag: null } });
        break;
      case 'renpy.jump':
        if (arg) events.push({ at: c.start, step: { t: 'jump', label: arg } });
        break;
      case 'renpy.call':
        if (arg) events.push({ at: c.start, step: { t: 'call', label: arg } });
        break;
    }
  }
  return [...setStep, ...events.sort((a, b) => a.at - b.at).map((e) => e.step)];
}

function userSteps(text: string, reg: Registry): Step[] {
  if (/^pause\b/.test(text)) return [{ t: 'pause' }];
  const video = findStringLiterals(text).find((l) => mediaKind(l.value) === 'video');
  if (video && /^(?:play|queue)\s+movie\b|movie/.test(text)) return [{ t: 'video', img: reg.resolveFile(video.value), name: video.value }];
  if (video) return [{ t: 'video', img: reg.resolveFile(video.value), name: video.value }];
  return [];
}

export function compileLabel(body: Stmt[], reg: Registry): Step[] {
  const steps: Step[] = [];
  let lastWho: string | null = null;

  const block = (stmts: Stmt[]): void => {
    for (const s of stmts) {
      switch (s.k) {
        case 'say': {
          const sp = reg.speaker(s.who);
          if (sp === 'extend') steps.push({ t: 'say', who: lastWho, what: stripTextTags(s.what), extend: true });
          else {
            lastWho = sp ? sp.id : null;
            steps.push({ t: 'say', who: lastWho, what: stripTextTags(s.what) });
          }
          break;
        }
        case 'scene': {
          if (!s.name && !s.expr) {
            steps.push({ t: 'bg', img: null, name: null, tag: null });
            break;
          }
          const name = s.name ? s.name.join(' ') : literalValue(s.expr) ?? s.expr;
          steps.push({ t: 'bg', img: reg.resolveDisplayable(s.name, s.expr), name, tag: s.name?.[0] ?? null });
          break;
        }
        case 'show': {
          const lit = s.expr ? literalValue(s.expr) : null;
          const name = s.name.length ? s.name.join(' ') : lit ?? s.expr ?? '';
          const tag = s.name[0] ?? (lit ? lit.split(/[\s/]/)[0] : 'expression');
          steps.push({ t: 'show', tag, img: reg.resolveDisplayable(s.name.length ? s.name : null, s.expr), name, pos: positionFromAt(s.at) });
          break;
        }
        case 'hide':
          steps.push({ t: 'hide', tag: s.name[0] });
          break;
        case 'python':
          steps.push(...pythonSteps(s.source, reg));
          break;
        case 'user':
          steps.push(...userSteps(s.text, reg));
          break;
        case 'menu': {
          const menu: Extract<Step, { t: 'menu' }> = { t: 'menu', choices: [], exit: -1 };
          steps.push(menu);
          const exits: Extract<Step, { t: 'goto' }>[] = [];
          for (const c of s.choices) {
            menu.choices.push({ text: stripTextTags(c.text), cond: c.cond, to: steps.length });
            block(c.body);
            const g: Extract<Step, { t: 'goto' }> = { t: 'goto', to: -1 };
            steps.push(g);
            exits.push(g);
          }
          for (const g of exits) g.to = steps.length;
          menu.exit = steps.length;
          break;
        }
        case 'if': {
          const br: Extract<Step, { t: 'branch' }> = { t: 'branch', options: [], exit: -1 };
          steps.push(br);
          const exits: Extract<Step, { t: 'goto' }>[] = [];
          for (const e of s.entries) {
            br.options.push({ cond: e.cond, to: steps.length });
            block(e.body);
            const g: Extract<Step, { t: 'goto' }> = { t: 'goto', to: -1 };
            steps.push(g);
            exits.push(g);
          }
          // No `else`: falling past every condition is also possible.
          if (!s.entries.some((e) => e.cond === 'True')) br.options.push({ cond: 'none of the above', to: -1 });
          for (const g of exits) g.to = steps.length;
          for (const o of br.options) if (o.to === -1) o.to = steps.length;
          br.exit = steps.length;
          break;
        }
        case 'while':
          block(s.body); // played once
          break;
        case 'jump':
          steps.push({ t: 'jump', label: s.target });
          return;
        case 'call':
          steps.push({ t: 'call', label: s.target });
          break;
        case 'return':
          steps.push({ t: 'return' });
          return;
        case 'label':
          // Execution falls into a nested label.
          steps.push({ t: 'jump', label: s.name });
          return;
        default:
          break;
      }
    }
  };

  block(body);
  return steps;
}

/** Every archive path a program can display. */
export function programPaths(steps: Step[], into: Set<string>): void {
  for (const s of steps) {
    if ((s.t === 'bg' || s.t === 'show' || s.t === 'video') && s.img) into.add(s.img);
  }
}
