/**
 * Phase 2 verification: fake Ren'Py game (Ren'Py 8-style + Ren'Py 6-style
 * .rpyc, .rpy fallback, translations, corrupt file) split across two archives.
 *
 *   python3 tests/fixtures/gen_phase2.py tests/fixtures/out2
 *   npx tsx tests/verify-phase2.mts tests/fixtures/out2
 */
import { openAsBlob, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { assetBlob } from '../src/lib/archiveClient.ts';
import { buildGalleryIndex, IndexCancelledError, type SourceFile } from '../src/lib/indexer.ts';
import { parseRpy } from '../src/lib/rpyParser.ts';
import { findCalls, literalValue, splitTopLevel } from '../src/lib/pyString.ts';
import { formatTitle } from '../src/lib/sceneParser.ts';
import type { GalleryIndex, SceneInfo } from '../src/types.ts';
import type { WorkerResponse } from '../src/workers/protocol.ts';

const dir = process.argv[2] ?? 'tests/fixtures/out2';
let passed = 0;
const failures: string[] = [];
const check = (name: string, ok: boolean, detail = '') => (ok ? passed++ : failures.push(`${name}${detail ? `: ${detail}` : ''}`));
const eq = (name: string, actual: unknown, expected: unknown) => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  check(name, a === e, `got ${a}, want ${e}`);
};

const names = ['scripts.rpa', 'images.rpa'];
const sources: SourceFile[] = await Promise.all(
  names.map(async (n) => ({ name: n, size: statSync(join(dir, n)).size, lastModified: 1700000000000, blob: await openAsBlob(join(dir, n)) })),
);
const media: Record<string, string> = JSON.parse(readFileSync(join(dir, 'media.json'), 'utf8'));

const index = await buildGalleryIndex(sources);
const scene = (id: string) => index.scenes.find((s) => s.id === id) as SceneInfo;

// ── sources & stats ──
eq('source kinds', index.sources.map((s) => [s.kind, s.version, s.entries]), [['rpa', 'RPA-3.0', 6], ['rpa', 'RPA-3.0', 9]]);
eq('cache key', index.key, [...sources].sort((a, b) => a.name.localeCompare(b.name)).map((s) => `${s.name}_${s.size}_1700000000000`).join('|'));
eq('scripts parsed (tl/ skipped, broken → .rpy)', [index.stats.scriptsParsed, index.stats.scriptsFailed], [4, 0]);
check('warns about broken.rpyc fallback', index.warnings.some((w) => w.startsWith('broken.rpyc') && w.includes('broken.rpy')));
check('warns about unknown node', index.warnings.some((w) => w.includes('renpy.ast.NewFancyNode')));

// ── scene selection & order ──
eq('scene ids in script order', index.scenes.map((s) => s.id), ['from_broken_source', 'gallery_extra', 'chapter_two', 'start', 'beach', 'beach.local']);
check('no translated duplicate', !index.scenes.some((s) => s.dialogue.some((d) => d.what === 'Bonjour' || d.what === 'Ligne française')));

// ── characters ──
const chars = Object.fromEntries(index.characters.map((c) => [c.id, c]));
eq('character names', index.characters.map((c) => [c.id, c.name]), [
  ['e', 'Eileen'], ['l', 'Lucy'], ['mc', '[player]'], ['g', 'Gina'], ['j', 'Jun'], ['lucy_alt', 'Lucy Alt'],
]);
eq('eileen colour', chars.e?.color, '#c8ffc8');
eq('multi-line define colour', chars.g?.color, '#f80');
eq('eileen scene count', chars.e?.sceneCount, 4);

// ── start: Movie image as scene, Translate-wrapped Say, sprite via image= ──
eq('start videos', scene('start').videos, ['video/intro.webm']);
eq('start thumbnail', scene('start').thumbnail, { path: 'video/intro.webm', kind: 'video' });
eq('start dialogue', scene('start').dialogue, [{ who: null, what: 'Narration line' }, { who: 'e', what: 'Hello there!' }]);
eq('start chars', scene('start').characters, ['e']);
check('sprites are not gallery images', !scene('start').images.length);

// ── beach: auto images, ref alias, menu, extend, cutscene, play movie ──
const beach = scene('beach');
eq('beach backgrounds', beach.backgrounds, ['images/bg beach.png', 'images/cg_kiss.jpg']);
eq('beach videos', beach.videos, ['video/ending.webm', 'video/extra.webm']);
eq('beach thumbnail prefers video', beach.thumbnail?.kind, 'video');
eq('beach speakers', beach.speakers, ['l', 'e']);
eq('extend continues speaker', beach.dialogue[1], { who: 'l', what: ' more' });
check('menu choices recorded', beach.dialogue.some((d) => d.choice && d.what === 'Kiss'));

// ── nested label, TranslateSay, renpy.image(), unknown node contents ──
const local = scene('beach.local');
eq('nested title', local.title, 'Beach · Local');
eq('nested images (renpy.image alias)', local.images, ['images/bg/sunset.webp']);
eq('nested speakers', local.speakers, ['mc', 'lucy_alt']);

// ── Ren'Py 6 file: literal speaker merges into e, 3-tuple imspec ──
eq('old rpyc backgrounds', scene('chapter_two').backgrounds, ['images/bg beach.png']);
eq('old rpyc speakers', scene('chapter_two').speakers, ['e', 'j']);

// ── .rpy source fallback ──
const extra = scene('gallery_extra');
eq('rpy scene expression', extra.backgrounds, ['images/cg_kiss.jpg']);
eq('rpy play movie', extra.videos, ['video/extra.webm']);
eq('rpy dialogue order', extra.dialogue.map((d) => d.what), [
  'Source-only line with a # not-a-comment', 'Gina speaks', 'What now?', 'Stay', 'Go', 'You stay.', 'Triple quoted narration',
]);

// ── assets: only referenced ones, bytes exact via lazy blobs ──
const referenced = new Set(index.scenes.flatMap((s) => [...s.images, ...s.videos]));
eq('asset table = referenced', Object.keys(index.assets).sort(), [...referenced].sort());
check('audio not referenced', !index.assets['audio/theme.ogg']);
for (const [path, ref] of Object.entries(index.assets)) {
  const bytes = Buffer.from(await assetBlob(sources.map((s) => s.blob), ref).arrayBuffer()).toString('hex');
  check(`asset bytes ${path}`, bytes === media[path]);
  check(`asset mime ${path}`, ref.mime === (path.endsWith('.webm') ? 'video/webm' : path.endsWith('.jpg') ? 'image/jpeg' : path.endsWith('.webp') ? 'image/webp' : 'image/png'));
}

// ── structured-clone safety (what postMessage / IndexedDB need) ──
try {
  const clone = structuredClone(index) as GalleryIndex;
  eq('structured clone', clone.scenes.length, index.scenes.length);
} catch (e) {
  check('structured clone', false, String(e));
}

// ── cancellation ──
try {
  await buildGalleryIndex(sources, { signal: { cancelled: true } });
  check('cancellation', false, 'no error');
} catch (e) {
  check('cancellation', e instanceof IndexCancelledError, String(e));
}

// ── worker message protocol (real worker module, minimal `self` shim) ──
{
  const messages: WorkerResponse[] = [];
  let handler: ((ev: { data: unknown }) => void) | null = null;
  (globalThis as any).self = {
    addEventListener: (_: string, fn: typeof handler) => (handler = fn),
    postMessage: (m: WorkerResponse) => messages.push(m),
  };
  await import('../src/workers/archive.worker.ts');
  const files = await Promise.all(names.map(async (n) => new File([await openAsBlob(join(dir, n))], n, { lastModified: 1700000000000 })));
  handler!({ data: { type: 'index', id: 7, files } });
  for (let i = 0; i < 200 && !messages.some((m) => m.type !== 'progress'); i++) await new Promise((r) => setTimeout(r, 10));
  const done = messages.find((m) => m.type === 'done');
  check('worker done message', !!done && done.id === 7, JSON.stringify(messages.at(-1)).slice(0, 200));
  check('worker progress messages', messages.some((m) => m.type === 'progress'));
  if (done?.type === 'done') eq('worker result matches', done.index.scenes.map((s) => s.id), index.scenes.map((s) => s.id));
}

// ── images-only archive (scripts loose elsewhere) → folder mode ──
{
  const only = await buildGalleryIndex([sources[1]]);
  eq('folder mode', only.mode, 'folders');
  eq('folder stats', [only.stats.scriptsFound, only.stats.images, only.stats.videos, only.stats.audio], [0, 5, 3, 1]);
  eq('folder scenes', only.scenes.map((s) => [s.id, s.title, s.images.length, s.videos.length]), [
    ['images', 'Top level', 3, 0],
    ['images/bg', 'Bg', 1, 0],
    ['images/sprites', 'Sprites', 1, 0],
    ['video', 'Video', 0, 3],
  ]);
  eq('folder categories', only.characters.map((c) => [c.name, c.sceneCount]), [['Bg', 1], ['Sprites', 1], ['Top level', 1], ['Video', 1]]);
  eq('folder thumbnail prefers video', only.scenes[3].thumbnail, { path: 'video/ending.webm', kind: 'video' });
  check('folder assets referenced', Object.keys(only.assets).length === 8);
  eq('scripts mode stats', [index.mode, index.stats.scriptsFound, index.stats.images], ['scripts', 4, 5]);
}

// ── unit checks for the source helpers ──
eq('literal _()', literalValue('_("Lucy")'), 'Lucy');
eq('literal concat', literalValue(`"a" 'b'`), 'ab');
eq('literal non-literal', literalValue('name + "x"'), null);
eq('split args', splitTopLevel('a, f(1, 2), "x, y", [3, 4]'), ['a', 'f(1, 2)', '"x, y"', '[3, 4]']);
eq('find Character call', findCalls('x = Character("A", color="#fff")', /Character/)[0]?.args.keyword.color, '"#fff"');
eq('titles', ['ch1_beachNight', 'day2.morning_scene', 'CG_03'].map(formatTitle), ['Ch 1 Beach Night', 'Day 2 · Morning Scene', 'CG 03']);
eq('rpy say forms', parseRpy('label a:\n    e "x"\n    "Bob" "y"\n    e happy -sad "z"\n    "n"\n').flatMap((s) => (s.k === 'label' ? s.body : [])).map((s) => (s.k === 'say' ? [s.who, s.what] : s.k)), [
  ['e', 'x'], ['"Bob"', 'y'], ['e', 'z'], [null, 'n'],
]);
eq('rpy show clauses', parseRpy('label a:\n    show eileen happy at left with dissolve\n    show screen hud\n    scene\n').flatMap((s) => (s.k === 'label' ? s.body : [])), [
  { k: 'show', name: ['eileen', 'happy'], expr: null, line: 2 },
  { k: 'scene', name: null, expr: null, line: 4 },
]);

console.log(`${passed} passed, ${failures.length} failed`);
for (const f of failures) console.log('  ✗ ' + f);
process.exit(failures.length ? 1 : 0);
