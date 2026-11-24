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
