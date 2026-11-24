/**
 * Static "what does this choice lead to?" analysis over compiled programs.
 *
 * For every menu choice and if-branch it follows the option's steps until the
 * option rejoins the scene, ends it, or jumps to another scene's label —
 * walking into labels only this option can reach — and records length,
 * images, videos, characters and variable changes. It then indexes every
 * condition in the game so a change like `lucy_love += 1` can say where it is
 * checked, and so an `if` can say which choices set the variables it tests.
 */

import type { ChoiceInfo, SceneInfo, ScenePrograms, Step, VarChange } from '../types';
import { mediaKind } from './media';

const WORDS_PER_SEC = 200 / 60;
const NOT_VARS = new Set(['and', 'or', 'not', 'in', 'is', 'True', 'False', 'None', 'if', 'else', 'renpy', 'store', 'len', 'str', 'int']);
const MAX_WALK = 20000;
const MAX_USED_IN = 12;

function readingSecs(text: string): number {
  const words = Math.max(text.split(/\s+/).filter(Boolean).length, text.length / 6);
  return words / WORDS_PER_SEC + 1;
}

/** Variable names in a Python condition, normalised (no `store.` prefix). */
export function conditionVars(cond: string): string[] {
  const out = new Set<string>();
  const stripped = cond.replace(/(["'])(?:\\.|(?!\1).)*\1/g, ''); // drop string literals
  for (const m of stripped.matchAll(/[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*/g)) {
    const name = m[0].replace(/^store\./, '');
    const base = name.split('.')[0];
    if (NOT_VARS.has(name) || NOT_VARS.has(base)) continue;
    if (/\(/.test(stripped.slice(m.index! + m[0].length, m.index! + m[0].length + 1))) continue; // function call
    out.add(name);
  }
  return [...out];
}

/** Lookup key for a changed variable (`points["lucy"]` → `points`). */
const varKey = (v: string) => v.replace(/\[.*$/, '');

export function describeChange(c: VarChange): string {
  if (c.op === 'call') return c.val;
  if (c.op === '+=') return `+${c.val}`;
  if (c.op === '-=') return `−${c.val}`;
  return `= ${c.val}`;
}

interface Acc {
  lines: number;
  secs: number;
  images: Set<string>;
  videos: Set<string>;
  chars: Set<string>;
  changes: VarChange[];
  visited: Set<string>;
  budget: number;
}

export function annotateChoices(programs: ScenePrograms, scenes: SceneInfo[]): void {
  const sceneOfLabel = new Map<string, SceneInfo>();
  for (const sc of scenes) for (const l of sc.labels) if (!sceneOfLabel.has(l)) sceneOfLabel.set(l, sc);
  const sceneOrder = new Map(scenes.map((s, i) => [s.id, i]));

  // How many ways into each label (jumps, calls, fall-through).
  const incoming = new Map<string, number>();
  const bump = (l: string) => incoming.set(l, (incoming.get(l) ?? 0) + 1);
  for (const prog of Object.values(programs.labels)) {
    for (const s of prog.steps) if (s.t === 'jump' || s.t === 'call') bump(s.label);
    if (prog.next) bump(prog.next);
  }

  // Where each variable is checked: variable → scenes.
  const checkedIn = new Map<string, Set<string>>();
  for (const [label, prog] of Object.entries(programs.labels)) {
    const sc = sceneOfLabel.get(label);
    if (!sc) continue;
    for (const s of prog.steps) {
      const conds = s.t === 'branch' ? s.options.map((o) => o.cond) : s.t === 'menu' ? s.choices.map((c) => c.cond ?? '') : [];
      for (const c of conds) {
        for (const v of conditionVars(c)) {
          const set = checkedIn.get(v) ?? new Set<string>();
          set.add(sc.id);
          checkedIn.set(v, set);
        }
      }
    }
  }

  const walk = (label: string, start: number, end: number | null, members: Set<string>, acc: Acc): ChoiceInfo['dest'] => {
    const prog = programs.labels[label];
    if (!prog) return { k: 'leaves', label };
    const steps = prog.steps;
    const limit = end ?? steps.length;
    const outer = end !== null;

    const follow = (target: string): ChoiceInfo['dest'] => {
      if (!members.has(target)) return { k: 'leaves', label: target };
      if (acc.visited.has(target) || (incoming.get(target) ?? 0) > 1) return { k: 'rejoin' };
      acc.visited.add(target);
      return walk(target, 0, null, members, acc);
    };

    let pc = start;
    while (pc < limit && acc.budget-- > 0) {
      const s: Step = steps[pc];
      switch (s.t) {
        case 'say':
          acc.lines++;
          acc.secs += readingSecs(s.what);
          if (s.who) acc.chars.add(s.who);
          break;
        case 'bg':
        case 'show':
          if (s.img) (mediaKind(s.img) === 'video' ? acc.videos : acc.images).add(s.img);
          break;
        case 'video':
          if (s.img) acc.videos.add(s.img);
          acc.secs += 6;
          break;
        case 'pause':
          acc.secs += 2;
          break;
        case 'set':
          acc.changes.push(...s.changes);
          break;
        case 'menu':
        case 'branch': {
          // Everything inside a nested fork is reachable from this option.
          const opts = s.t === 'menu' ? s.choices : s.options;
          opts.forEach((o, i) => walk(label, o.to, opts[i + 1]?.to ?? s.exit, members, acc));
          if (s.t === 'menu') acc.secs += 3;
          pc = s.exit;
          continue;
        }
        case 'goto':
          if (outer && (s.to < start || s.to >= limit)) return { k: 'rejoin' };
          pc = s.to;
          continue;
        case 'jump':
          return follow(s.label);
        case 'return':
          return { k: 'ends' };
        default:
          break; // hide, call (shared content not counted)
      }
      pc++;
    }
    if (outer) return { k: 'rejoin' };
    return prog.next ? follow(prog.next) : { k: 'ends' };
  };

  const analyse = (label: string, start: number, end: number, members: Set<string>): { info: ChoiceInfo; imgs: Set<string> } => {
    const acc: Acc = { lines: 0, secs: 0, images: new Set(), videos: new Set(), chars: new Set(), changes: [], visited: new Set([label]), budget: MAX_WALK };
    const dest = walk(label, start, end, members, acc);
    // Merge repeated numeric changes to the same variable (+1 +1 → +2).
    const merged: VarChange[] = [];
    for (const c of acc.changes) {
      const prev = merged.find((m) => m.v === c.v && m.op === c.op && (c.op === '+=' || c.op === '-='));
      if (prev && /^\d+(\.\d+)?$/.test(prev.val) && /^\d+(\.\d+)?$/.test(c.val)) prev.val = String(+prev.val + +c.val);
      else if (!merged.some((m) => m.v === c.v && m.op === c.op && m.val === c.val)) merged.push({ ...c });
    }
    const usedIn = merged
      .filter((c) => c.op !== 'call')
      .map((c) => {
        const set = checkedIn.get(varKey(c.v)) ?? checkedIn.get(c.v);
        const list = set ? [...set].sort((a, b) => (sceneOrder.get(a) ?? 0) - (sceneOrder.get(b) ?? 0)) : [];
        return { v: c.v, scenes: list.slice(0, MAX_USED_IN), total: list.length };
      })
      .filter((u) => u.total > 0);
    return {
      imgs: acc.images,
      info: {
        dest,
        lines: acc.lines,
        secs: Math.round(acc.secs),
        images: acc.images.size,
        uniqueImages: 0,
        videos: acc.videos.size,
        chars: [...acc.chars],
        changes: merged,
        usedIn,
      },
    };
  };

  // Pass 1: menus (and remember which choices set which variables).
  const setBy = new Map<string, { scene: string; choice: string; change: string }[]>();
  const branches: { label: string; step: Extract<Step, { t: 'branch' }>; members: Set<string> }[] = [];
  for (const [label, prog] of Object.entries(programs.labels)) {
    const sc = sceneOfLabel.get(label);
    const members = new Set(sc?.labels ?? [label]);
    for (const s of prog.steps) {
      if (s.t === 'branch') branches.push({ label, step: s, members });
      if (s.t !== 'menu') continue;
      const results = s.choices.map((c, i) => analyse(label, c.to, s.choices[i + 1]?.to ?? s.exit, members));
      results.forEach((r, i) => {
        const others = new Set(results.filter((_, j) => j !== i).flatMap((o) => [...o.imgs]));
        r.info.uniqueImages = [...r.imgs].filter((p) => !others.has(p)).length;
        s.choices[i].info = r.info;
        for (const ch of r.info.changes) {
          const key = varKey(ch.v);
          const list = setBy.get(key) ?? [];
          if (list.length < 20) list.push({ scene: sc?.id ?? label, choice: s.choices[i].text, change: describeChange(ch) });
          setBy.set(key, list);
        }
      });
    }
  }

  // Pass 2: if-branches, with what their conditions depend on.
  for (const { label, step, members } of branches) {
    const results = step.options.map((o, i) => analyse(label, o.to, step.options[i + 1]?.to ?? step.exit, members));
    results.forEach((r, i) => {
      const others = new Set(results.filter((_, j) => j !== i).flatMap((o) => [...o.imgs]));
      r.info.uniqueImages = [...r.imgs].filter((p) => !others.has(p)).length;
      const deps = conditionVars(step.options[i].cond)
        .map((v) => ({ v, setBy: (setBy.get(varKey(v)) ?? setBy.get(v) ?? []).slice(0, 6) }))
        .filter((d) => d.setBy.length);
      if (deps.length) r.info.deps = deps;
      step.options[i].info = r.info;
    });
  }
}
