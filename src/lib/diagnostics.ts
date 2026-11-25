/**
 * "Export diagnostics": a JSON summary of how the app read a game — sources,
 * folders, scripts, characters, scenes, labels and replay-screen code — so
 * portrait picking, scene merging and the like can be tuned without the game
 * files themselves. No images, audio or dialogue are included.
 */
import type { GalleryIndex, ScenePrograms, Step } from '../types';
import { conditionVars } from './consequences';

const MAX_LABELS = 4000;
const MAX_VARIABLES = 400;
const MAX_UNRESOLVED = 300;

type LabelSummary = {
  name: string;
  file: string;
  scene: string | null;
  steps: number;
  says: number;
  menus: number;
  choices: number;
  branches: number;
  images: number;
  videos: number;
  audio: number;
  sets: number;
  jumps: string[];
  calls: string[];
  next: string | null;
};

function summarizeLabel(name: string, file: string, steps: Step[], next: string | null, scene: string | null): LabelSummary {
  const s: LabelSummary = { name, file, scene, steps: steps.length, says: 0, menus: 0, choices: 0, branches: 0, images: 0, videos: 0, audio: 0, sets: 0, jumps: [], calls: [], next };
  for (const st of steps) {
    switch (st.t) {
      case 'say': s.says++; break;
      case 'menu': s.menus++; s.choices += st.choices.length; break;
      case 'branch': s.branches++; break;
      case 'bg': case 'show': s.images++; break;
      case 'video': s.videos++; break;
      case 'audio': s.audio++; break;
      case 'set': s.sets++; break;
      case 'jump': if (!s.jumps.includes(st.label)) s.jumps.push(st.label); break;
      case 'call': if (!s.calls.includes(st.label)) s.calls.push(st.label); break;
    }
  }
  return s;
}

/** Story variables: how often each is changed by choices and checked by conditions (names and values only). */
function summarizeVariables(programs: ScenePrograms) {
  type V = { name: string; sets: number; inChoices: number; checks: number; ops: string[]; checkedAs: string[] };
  const vars = new Map<string, V>();
  const get = (name: string) => {
    let v = vars.get(name);
    if (!v) vars.set(name, (v = { name, sets: 0, inChoices: 0, checks: 0, ops: [], checkedAs: [] }));
    return v;
  };
  const calls = new Map<string, { fn: string; uses: number; samples: string[] }>();
  for (const lp of Object.values(programs.labels)) {
    lp.steps.forEach((st, pc) => {
      if (st.t === 'set') {
        // A change within a few steps of a menu choice's start counts as "set by a choice".
        const near = lp.steps.slice(Math.max(0, pc - 40), pc).some((p) => p.t === 'menu');
        for (const c of st.changes) {
          if (c.op === 'call') {
            const fn = /^([\w.]+)\s*\(/.exec(c.val)?.[1] ?? c.val.slice(0, 40);
            const e = calls.get(fn) ?? { fn, uses: 0, samples: [] };
            e.uses++;
            if (e.samples.length < 3 && !e.samples.includes(c.val)) e.samples.push(c.val.slice(0, 80));
            calls.set(fn, e);
            continue;
          }
          const v = get(c.v);
          v.sets++;
          if (near) v.inChoices++;
          const op = `${c.op} ${c.val}`.slice(0, 40);
          if (v.ops.length < 4 && !v.ops.includes(op)) v.ops.push(op);
        }
      } else if (st.t === 'menu' || st.t === 'branch') {
        const conds = st.t === 'menu' ? st.choices.map((c) => c.cond ?? '') : st.options.map((o) => o.cond);
        for (const cond of conds) {
          for (const name of conditionVars(cond)) {
            const v = get(name);
            v.checks++;
            if (v.checkedAs.length < 3 && !v.checkedAs.includes(cond)) v.checkedAs.push(cond.slice(0, 80));
          }
        }
      }
    });
  }
  const list = [...vars.values()].sort((a, b) => b.sets + b.checks - (a.sets + a.checks));
  return {
    total: list.length,
    truncated: list.length > MAX_VARIABLES,
    list: list.slice(0, MAX_VARIABLES),
    calls: [...calls.values()].sort((a, b) => b.uses - a.uses).slice(0, 60),
  };
}

function readCustomPortraits(key: string): Record<string, string> {
  try {
    const raw = localStorage.getItem(`rpa.portraits.${key}`);
    const v = raw ? (JSON.parse(raw) as unknown) : null;
    return v && typeof v === 'object' ? (v as Record<string, string>) : {};
  } catch {
    return {};
  }
}

export function buildDiagnostics(index: GalleryIndex, programs: ScenePrograms | null | undefined, filesAttached: boolean) {
  const sceneOf = new Map<string, string>();
  for (const sc of index.scenes) for (const l of sc.labels) if (!sceneOf.has(l)) sceneOf.set(l, sc.id);
  const custom = readCustomPortraits(index.key);

  const labels: LabelSummary[] = [];
  const unresolved = new Map<string, number>();
  if (programs) {
    for (const [name, lp] of Object.entries(programs.labels)) {
      if (labels.length < MAX_LABELS) labels.push(summarizeLabel(name, lp.file, lp.steps, lp.next, sceneOf.get(name) ?? null));
      for (const st of lp.steps) {
        // `black` is Ren'Py's built-in solid black, not a missing file.
        if ((st.t === 'bg' || st.t === 'show' || st.t === 'video') && !st.img && st.name && st.name !== 'black') {
          unresolved.set(st.name, (unresolved.get(st.name) ?? 0) + 1);
        }
      }
    }
    labels.sort((a, b) => a.file.localeCompare(b.file) || a.name.localeCompare(b.name));
  }

  const replayTargets = new Map<string, string | null>();
  for (const r of index.diag?.replay ?? []) {
    for (const m of r.text.matchAll(/Replay\s*\(\s*(?:u?["']([^"']+)["'])/g)) replayTargets.set(m[1], sceneOf.get(m[1]) ?? null);
  }

  return {
    tool: 'rpa-gallery diagnostics',
    format: 1,
    generatedAt: new Date().toISOString(),
    device: {
      userAgent: navigator.userAgent,
      screen: `${screen.width}x${screen.height}@${devicePixelRatio}`,
      app: location.href.split('?')[0],
    },
    filesAttached,
    game: {
      mode: index.mode,
      sources: index.sources,
      stats: index.stats,
      warnings: index.warnings,
    },
    characters: index.characters.map((c) => ({
      id: c.id,
      name: c.name,
      color: c.color,
      role: c.role ?? null,
      aliases: c.aliases ?? [],
      scenes: c.sceneCount,
      lines: c.lineCount,
      portrait: c.portrait ?? null,
      customPortrait: custom[c.id] ?? null,
      candidates: (c.portraitCandidates ?? []).slice(0, 10),
    })),
    scenes: index.scenes.map((s) => ({
      id: s.id,
      title: s.title,
      file: s.file,
      line: s.line,
      labels: s.labels,
      secs: s.durationSec,
      lines: s.dialogueCount,
      speakers: s.speakers,
      characters: s.characters,
      backgrounds: s.backgrounds.length,
      images: s.images.length,
      videos: s.videos.length,
      thumbnail: s.thumbnail?.path ?? null,
    })),
    labels: { total: programs ? Object.keys(programs.labels).length : null, truncated: !!programs && Object.keys(programs.labels).length > MAX_LABELS, list: labels },
    variables: programs ? summarizeVariables(programs) : null,
    unresolvedImages: [...unresolved].sort((a, b) => b[1] - a[1]).slice(0, MAX_UNRESOLVED).map(([name, uses]) => ({ name, uses })),
    stage: programs?.stage ?? null,
    audioChannels: programs?.channels ?? null,
    replay: {
      screens: index.diag?.screens ?? [],
      lines: index.diag?.replay ?? [],
      targets: [...replayTargets].map(([label, scene]) => ({ label, scene })),
      code: index.diag?.code ?? [],
    },
    folders: index.diag?.folders ?? [],
    foldersTruncated: index.diag?.foldersTruncated ?? false,
    scripts: index.diag?.scripts ?? [],
  };
}

function slug(index: GalleryIndex): string {
  const src = index.sources.find((s) => s.kind === 'apk') ?? index.sources.find((s) => s.kind === 'rpa') ?? index.sources[0];
  const base = (src?.name ?? 'game').replace(/\.[^.]+$/, '');
  return base.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'game';
}

/**
 * Shares the report through the phone's share sheet when it can (as .txt, which
 * Android accepts for sharing), otherwise downloads it as .json.
 */
export async function exportDiagnostics(index: GalleryIndex, programs: ScenePrograms | null | undefined, filesAttached: boolean): Promise<'shared' | 'downloaded' | 'cancelled'> {
  const json = JSON.stringify(buildDiagnostics(index, programs, filesAttached), null, 1);
  const stamp = new Date().toISOString().slice(0, 10);
  const name = `rpa-gallery-diagnostics-${slug(index)}-${stamp}`;

  const txt = new File([json], `${name}.txt`, { type: 'text/plain' });
  if (navigator.canShare?.({ files: [txt] })) {
    try {
      await navigator.share({ files: [txt], title: 'RPA Gallery diagnostics' });
      return 'shared';
    } catch (e) {
      if ((e as Error)?.name === 'AbortError') return 'cancelled';
      // Share failed for another reason: fall back to a download.
    }
  }
  const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `${name}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Chrome holds the blob once the download starts; keep the URL briefly, then free it.
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  return 'downloaded';
}
