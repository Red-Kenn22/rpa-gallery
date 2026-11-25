import type { ChoiceInfo, VarChange } from '../types';
import { describeChange } from './consequences';
import { formatDuration } from './format';

/** eileen_love → "Eileen love", lucy.affection → "Lucy affection", persistent.x → "X (persistent)". */
export function humanizeVar(v: string): string {
  let name = v;
  let suffix = '';
  if (name.startsWith('persistent.')) {
    name = name.slice(11);
    suffix = ' (persistent)';
  }
  const words = name
    .replace(/\[["']?([^"'\]]+)["']?\]/g, ' $1')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .split(/[._\s]+/)
    .filter(Boolean)
    .join(' ');
  return (words ? words[0].toUpperCase() + words.slice(1) : v) + suffix;
}

export function changeText(c: VarChange): string {
  return c.op === 'call' ? c.val : `${humanizeVar(c.v)} ${describeChange(c)}`;
}

export function destText(info: ChoiceInfo, titleFor: (label: string) => string | undefined): string {
  switch (info.dest.k) {
    case 'ends':
      return 'Ends scene';
    case 'leaves': {
      const t = titleFor(info.dest.label);
      return t ? `Continues: ${t}` : `Jumps to ${info.dest.label}`;
    }
    default: {
      if (info.lines) return `Rejoins after ${info.lines} line${info.lines === 1 ? '' : 's'}`;
      const media = info.images + info.videos;
      if (media) return `Rejoins after ${media} image${media === 1 ? '' : 's'}`;
      return 'Continues straight on';
    }
  }
}

export function contentText(info: ChoiceInfo): string[] {
  const out: string[] = [];
  if (info.secs >= 10) out.push(formatDuration(info.secs));
  if (info.uniqueImages) out.push(`${info.uniqueImages} new image${info.uniqueImages === 1 ? '' : 's'}`);
  if (info.videos) out.push(`${info.videos} video${info.videos === 1 ? '' : 's'}`);
  return out;
}

// ---------------------------------------------------------------------------
// Plain-language consequences: who a stat belongs to, a one-line verdict per
// option, a summary across a menu's options, and readable conditions.

/** Words that mark a variable as a relationship/route stat. */
const STAT_WORDS = new Set([
  'love', 'points', 'point', 'pts', 'lp', 'affection', 'aff', 'lust', 'trust', 'rel', 'relationship', 'like', 'likes',
  'friendship', 'corruption', 'corrupt', 'romance', 'sub', 'dom', 'path', 'route', 'score', 'interest', 'attraction',
]);

export interface StatOwner {
  name: string;
  color?: string;
}

export type CharMatcher = (v: string) => { who: StatOwner; stat: string } | null;

/**
 * Maps variable names to the character they belong to: `annie_love`,
 * `love["annie"]`, `annielove`, `points_annie` → Annie + "love"/"points".
 * Keys are character names (first word) and ids/aliases of 3+ letters.
 */
export function makeCharMatcher(chars: { id: string; name: string; aliases?: string[]; color?: string }[]): CharMatcher {
  const keys = new Map<string, StatOwner>();
  const add = (k: string, who: StatOwner) => {
    const key = k.toLowerCase();
    if (/^[a-z]{3,}$/.test(key) && !STAT_WORDS.has(key) && !keys.has(key)) keys.set(key, who);
  };
  for (const c of chars) {
    const first = c.name.replace(/\[[^\]]*\]/g, '').trim().split(/\s+/)[0] ?? '';
    if (!first) continue;
    const who = { name: c.name, color: c.color };
    add(first, who);
    add(c.id, who);
    for (const a of c.aliases ?? []) add(a, who);
  }
  return (v: string) => {
    const tokens = v.replace(/^(store|persistent)\./, '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      const rest = () => tokens.filter((_, j) => j !== i);
      const exact = keys.get(t);
      if (exact) return { who: exact, stat: rest().join(' ') || 'points' };
      for (const [k, who] of keys) {
        if (t.startsWith(k) && STAT_WORDS.has(t.slice(k.length))) return { who, stat: [t.slice(k.length), ...rest()].join(' ') };
        if (t.endsWith(k) && STAT_WORDS.has(t.slice(0, -k.length))) return { who, stat: [t.slice(0, -k.length), ...rest()].join(' ') };
      }
    }
    return null;
  };
}

export interface ChangeChip {
  text: string;
  color?: string;
}

/** One readable chip per change: "Lucy love +2", "Turns on: Dalia path", "Lucy points +1". */
export function changeChip(c: VarChange, match: CharMatcher): ChangeChip {
  if (c.op === 'call') {
    const m = /^([\w.]+)\s*\((.*)\)\s*$/.exec(c.val);
    if (m) {
      const args = m[2].split(',').map((a) => a.trim());
      const str = args.map((a) => /^u?["']([^"']+)["']$/.exec(a)?.[1]).find(Boolean);
      const num = args.find((a) => /^[-+]?\d+(\.\d+)?$/.test(a));
      const owner = str ? match(str) : null;
      if (owner) {
        const stat = m[1].split(/[_.]/).filter((w) => !/^(add|inc|increase|give|raise|change|set|update|mod)$/i.test(w)).join(' ') || 'points';
        const n = num ? (num.startsWith('-') ? `−${num.slice(1)}` : `+${num.replace(/^\+/, '')}`) : '';
        return { text: `${owner.who.name} ${stat}${n ? ` ${n}` : ''}`.trim(), color: owner.who.color };
      }
    }
    return { text: c.val };
  }
  const owner = match(c.v);
  const label = owner ? `${owner.who.name} ${owner.stat}` : humanizeVar(c.v);
  const color = owner?.who.color;
  if (c.op === '=') {
    if (c.val === 'True') return { text: `Turns on: ${label}`, color };
    if (c.val === 'False') return { text: `Turns off: ${label}`, color };
    return { text: `${label} = ${c.val.replace(/^u?["']|["']$/g, '')}`, color };
  }
  return { text: `${label} ${describeChange(c)}`, color };
}

export type VerdictKind = 'leaves' | 'ends' | 'lasting' | 'untracked' | 'none';

/** The one thing to know about an option, in plain words. */
export function choiceVerdict(
  info: ChoiceInfo,
  titleFor: (label: string) => string | undefined,
  thisScene?: string,
  /** If-branches describe what the game does, not a choice you make. */
  branch = false,
): { k: VerdictKind; text: string } {
  if (info.dest.k === 'leaves') {
    const t = titleFor(info.dest.label);
    return { k: 'leaves', text: t ? `Leads to a different scene: ${t}` : `Leads to a different scene (${info.dest.label})` };
  }
  if (info.dest.k === 'ends') return { k: 'ends', text: 'Ends the scene here' };
  if (info.usedIn.length) {
    const scenes = new Set(info.usedIn.flatMap((u) => u.scenes));
    const n = Math.max(scenes.size, ...info.usedIn.map((u) => u.total));
    if (thisScene && scenes.size === 1 && scenes.has(thisScene) && n === 1) return { k: 'lasting', text: 'Changes what happens later in this scene' };
    return { k: 'lasting', text: `Changes what happens later · ${n === 1 ? '1 scene checks' : `${n} scenes check`} this` };
  }
  if (info.changes.length) {
    const onlyCalls = info.changes.every((c) => c.op === 'call');
    return { k: 'untracked', text: onlyCalls ? 'Changes stats · may matter later' : 'Changes stats · no scene here checks them' };
  }
  if (branch) {
    const media = info.images + info.videos;
    const what = info.lines ? `${info.lines} line${info.lines === 1 ? '' : 's'}` : media ? `${media} image${media === 1 ? '' : 's'}` : '';
    return { k: 'none', text: what ? `Small difference · rejoins after ${what}` : 'Carries straight on' };
  }
  return { k: 'none', text: 'No lasting effect · the story carries on the same' };
}

const short = (s: string, n = 40) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/** A sentence comparing a menu's options, or null when there's nothing useful to say. */
export function menuSummary(
  options: { text: string; info?: ChoiceInfo }[],
  titleFor: (label: string) => string | undefined,
  thisScene?: string,
): string | null {
  const known = options.filter((o) => o.info);
  if (known.length < 2 || known.length !== options.length) return null;
  const kinds = known.map((o) => choiceVerdict(o.info!, titleFor, thisScene).k);
  if (kinds.every((k) => k === 'none')) return 'None of these has a lasting effect. Pick whichever you want to see.';
  const dests = new Set(known.map((o) => (o.info!.dest.k === 'leaves' ? o.info!.dest.label : o.info!.dest.k)));
  if (kinds.every((k) => k === 'leaves') && dests.size === known.length) return 'Each option leads to a different scene.';
  const matters = known.filter((_, i) => kinds[i] !== 'none');
  if (matters.length === 1) return `Only “${short(matters[0].text)}” has lasting effects.`;
  if (matters.length < known.length) return `${matters.length} of ${known.length} options have lasting effects.`;
  return null;
}

const OPS: Record<string, string> = { '>=': '≥', '<=': '≤', '!=': '≠', '==': '=', '>': '>', '<': '<' };
const COND_WORDS = new Set(['and', 'or', 'not', 'in', 'is', 'True', 'False', 'None']);

/** `store.annie_love >= 3 and not nancy_path` → "Annie love ≥ 3 and not Nancy path". */
export function conditionText(cond: string, match?: CharMatcher): string {
  const label = (v: string) => {
    const o = match?.(v);
    return o ? `${o.who.name} ${o.stat}` : humanizeVar(v);
  };
  let s = cond.trim();
  s = s.replace(/\s*==\s*True\b/g, '').replace(/\s*is\s+True\b/g, '');
  s = s.replace(/([A-Za-z_][\w.]*(?:\[[^\]]+\])?)\s*(?:==|is)\s*False\b/g, 'not $1');
  const out: string[] = [];
  const re = /(u?["'][^"']*["'])|([A-Za-z_][\w.]*(?:\[[^\]]+\])?)(\s*\()?|(>=|<=|!=|==|>|<)|(\s+)|(.)/g;
  for (const m of s.matchAll(re)) {
    if (m[1]) out.push(m[1].replace(/^u/, ''));
    else if (m[2]) {
      const name = m[2].replace(/^store\./, '');
      if (m[3]) out.push(m[2] + m[3]);
      else if (COND_WORDS.has(name)) out.push(name);
      else out.push(label(name));
    } else if (m[4]) out.push(OPS[m[4]]);
    else out.push(m[0]);
  }
  return out.join('').replace(/\s+/g, ' ').trim();
}
