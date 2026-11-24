/**
 * Phase 2 verification: fake Ren'Py game (Ren'Py 8-style + Ren'Py 6-style
 * .rpyc, .rpy fallback, translations, corrupt file) split across two archives.
 *
 *   python3 tests/fixtures/gen_phase2.py tests/fixtures/out2
 *   npx tsx tests/verify-phase2.mts tests/fixtures/out2
 */
import { openAsBlob, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { loadAssetBlob } from '../src/lib/archiveClient.ts';
import { buildGalleryIndex, IndexCancelledError, type SourceFile } from '../src/lib/indexer.ts';
import { parseRpy } from '../src/lib/rpyParser.ts';
import { PlayerEngine } from '../src/lib/playerEngine.ts';
import { findCalls, literalValue, splitTopLevel } from '../src/lib/pyString.ts';
import { formatTitle } from '../src/lib/sceneParser.ts';
import type { GalleryIndex, SceneInfo, Step } from '../src/types.ts';
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

const { index, programs } = await buildGalleryIndex(sources);
const scene = (id: string) => index.scenes.find((s) => s.id === id) as SceneInfo;

// ── sources & stats ──
eq('source kinds', index.sources.map((s) => [s.kind, s.version, s.entries]), [['rpa', 'RPA-3.0', 6], ['rpa', 'RPA-3.0', 9]]);
eq('cache key', index.key, [...sources].sort((a, b) => a.name.localeCompare(b.name)).map((s) => `${s.name}_${s.size}_1700000000000`).join('|'));
eq('scripts parsed (tl/ skipped, broken → .rpy)', [index.stats.scriptsParsed, index.stats.scriptsFailed], [4, 0]);
check('warns about broken.rpyc fallback', index.warnings.some((w) => w.startsWith('broken.rpyc') && w.includes('broken.rpy')));
check('warns about unknown node', index.warnings.some((w) => w.includes('renpy.ast.NewFancyNode')));

// ── scene selection & order ──
eq('scene ids in script order', index.scenes.map((s) => s.id), ['from_broken_source', 'gallery_extra', 'chapter_two', 'start', 'beach', 'w1_date', 'w1_night', 'common_phone']);
check('no translated duplicate', !index.scenes.some((s) => s.dialogue.some((d) => d.what === 'Bonjour' || d.what === 'Ligne française')));

// ── characters ──
const chars = Object.fromEntries(index.characters.map((c) => [c.id, c]));
eq('character names', index.characters.map((c) => [c.id, c.name]), [
  ['e', 'Eileen'], ['l', 'Lucy'], ['mc', '[player]'], ['g', 'Gina'], ['j', 'Jun'], ['lucy_alt', 'Lucy Alt'],
]);
eq('eileen colour', chars.e?.color, '#c8ffc8');
eq('multi-line define colour', chars.g?.color, '#f80');
eq('eileen scene count', chars.e?.sceneCount, 5);

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
eq('beach speakers', beach.speakers, ['l', 'e', 'mc', 'lucy_alt']);
eq('extend continues speaker', beach.dialogue[1], { who: 'l', what: ' more' });
check('menu choices recorded', beach.dialogue.some((d) => d.choice && d.what === 'Kiss'));

// ── nested label merged into its parent; TranslateSay, renpy.image(), unknown node contents ──
eq('local label merged', beach.labels, ['beach', 'beach.local']);
eq('merged images (renpy.image alias)', beach.images, ['images/bg beach.png', 'images/cg_kiss.jpg', 'images/bg/sunset.webp']);
eq('merged speakers', beach.speakers, ['l', 'e', 'mc', 'lucy_alt']);

// ── split scene: menu branch labels + rejoin + _part2 continuation merge; linear jump splits ──
eq('branch/rejoin/continuation merge', scene('w1_date').labels, ['w1_date', 'w1_date_park', 'w1_date_cafe', 'w1_date_end', 'w1_date_part2']);
eq('linear jump starts a new scene', scene('w1_night').labels, ['w1_night']);
eq('shared subroutine stays separate', scene('common_phone').labels, ['common_phone']);
check('durations estimated', index.scenes.every((s) => s.durationSec > 0), JSON.stringify(index.scenes.map((s) => s.durationSec)));
check('typical path counts the average branch', scene('w1_date').durationSec > 10 && scene('w1_date').durationSec < 30, String(scene('w1_date').durationSec));

// ── player programs ──
check('programs present', !!programs && Object.keys(programs.labels).length === 16, String(programs && Object.keys(programs.labels).length));
eq('stage from gui.init', programs?.stage, { w: 1280, h: 720 });
const dateSteps = programs!.labels['w1_date'].steps;
eq('show at left → position', dateSteps.find((s) => s.t === 'show'), { t: 'show', tag: 'eileen', img: 'images/sprites/eileen_happy.png', name: 'eileen happy', pos: [0, 1] });
eq('call step', dateSteps.find((s) => s.t === 'call'), { t: 'call', label: 'common_phone' });
const dateMenu = dateSteps.find((s) => s.t === 'menu') as Extract<Step, { t: 'menu' }>;
eq('menu with condition', [dateMenu.choices.map((c) => [c.text, c.cond, c.to]), dateMenu.exit], [[['Park', null, 5], ['Cafe', 'affection >= 5', 7], ['Go home', null, 9]], 11]);
eq('set + hide + bg + pause', programs!.labels['w1_date_cafe'].steps.map((s) => s.t), ['set', 'hide', 'bg', 'pause', 'jump']);
eq('variable changes parsed', (programs!.labels['w1_date_cafe'].steps[0] as any).changes, [
  { v: 'lucy_love', op: '+=', val: '2' }, { v: 'met_cafe', op: '=', val: 'True' }, { v: 'add_points', op: 'call', val: 'add_points("lucy", 1)' },
]);

// ── choice consequences ──
const [park, cafe, home] = dateMenu.choices.map((c) => c.info!);
eq('park: rejoins, 1 line, changes', [park.dest, park.lines, park.changes], [{ k: 'rejoin' }, 1, [{ v: 'eileen_love', op: '+=', val: '1' }]]);
eq('park: change checked later', park.usedIn, [{ v: 'eileen_love', scenes: ['w1_night'], total: 1 }]);
eq('cafe: new image only on this choice', [cafe.images, cafe.uniqueImages, cafe.dest], [1, 1, { k: 'rejoin' }]);
eq('cafe: three changes, none checked', [cafe.changes.length, cafe.usedIn], [3, []]);
eq('go home: leaves the scene', home.dest, { k: 'leaves', label: 'w1_night' });
const nightBranch = programs!.labels['w1_night'].steps.find((s) => s.t === 'branch') as Extract<Step, { t: 'branch' }>;
eq('if depends on a choice', nightBranch.options[0].info?.deps, [{ v: 'eileen_love', setBy: [{ scene: 'w1_date', choice: 'Park', change: '+1' }] }]);
eq('beach menu: kiss has the cg, leave has nothing new', (programs!.labels['beach'].steps[4] as any).choices.map((c: any) => [c.info.uniqueImages, c.info.lines]), [[1, 1], [0, 0]]);
eq('return step', programs!.labels['common_phone'].steps.at(-1), { t: 'return' });
eq('fall-through target', programs!.labels['beach.local'].next, 'w1_date');
eq('extend step', programs!.labels['beach'].steps[3], { t: 'say', who: 'l', what: ' more', extend: true });
eq('if → branch with else', (programs!.labels['beach'].steps.find((s) => s.t === 'branch') as any)?.options.map((o: any) => o.cond), ['night', 'True']);
check('character sprites referenced for the player', !!index.assets['images/sprites/eileen_happy.png']);
eq('speaker table', programs?.speakers.e, { name: 'Eileen', color: '#c8ffc8' });

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
for (const lp of Object.values(programs!.labels)) for (const st of lp.steps) if ((st.t === 'bg' || st.t === 'show' || st.t === 'video') && st.img) referenced.add(st.img);
eq('asset table = scene media + player images', Object.keys(index.assets).sort(), [...referenced].sort());
check('audio not referenced', !index.assets['audio/theme.ogg']);
for (const [path, ref] of Object.entries(index.assets)) {
  const bytes = Buffer.from(await (await loadAssetBlob(sources.map((s) => s.blob), ref)).arrayBuffer()).toString('hex');
  check(`asset bytes ${path}`, bytes === media[path]);
  check(`asset mime ${path}`, ref.mime === (path.endsWith('.webm') ? 'video/webm' : path.endsWith('.jpg') ? 'image/jpeg' : path.endsWith('.webp') ? 'image/webp' : 'image/png'));
}

// ── player engine walks a merged scene ──
{
  const say = (e: PlayerEngine) => e.view.say?.what ?? null;
  const p = new PlayerEngine(programs!, scene('beach').labels);
  eq('engine: first stop', [p.view.bg?.img, p.view.layers.map((l) => l.img), say(p)], ['images/bg beach.png', ['images/lucy smile.png'], 'Hi']);
  p.advance();
  eq('engine: extend appends', say(p), 'Hi more');
  p.advance();
  eq('engine: menu', p.view.menu?.map((c) => c.text), ['Kiss', 'Leave']);
  p.advance();
  check('engine: tap does nothing on a menu', !!p.view.menu);
  p.choose(0);
  eq('engine: choice runs its branch', [p.view.bg?.img, p.view.layers.length, say(p)], ['images/cg_kiss.jpg', 0, 'Mm.']);
  p.advance();
  eq('engine: if asks', p.view.branch?.map((b) => b.cond), ['night', 'True']);
  p.choose(1);
  eq('engine: cutscene', p.view.video?.img, 'video/ending.webm');
  p.advance();
  eq('engine: second cutscene', p.view.video?.img, 'video/extra.webm');
  p.advance();
  eq('engine: falls into nested label', [p.view.label, say(p)], ['beach.local', 'Nested label line']);
  p.advance();
  eq('engine: show inside nested label', [p.view.layers.map((l) => l.img), say(p)], [['images/bg/sunset.webp'], 'Inside an unknown node']);
  p.advance();
  eq('engine: leaving the scene ends it', p.view.ended, { reason: 'left-scene', nextLabel: 'w1_date' });
  p.back();
  eq('engine: back is exact', [say(p), p.view.ended], ['Inside an unknown node', null]);
  check('engine: lines counted', p.linesShown === 5, String(p.linesShown));

  const d = new PlayerEngine(programs!, scene('w1_date').labels);
  eq('engine: sprite position', d.view.layers[0]?.pos, [0, 1]);
  d.advance();
  eq('engine: call into shared label', [d.view.label, say(d)], ['common_phone', 'Your phone buzzes.']);
  d.advance();
  eq('engine: returns to the menu', d.view.menu?.map((c) => [c.text, c.cond]), [['Park', null], ['Cafe', 'affection >= 5'], ['Go home', null]]);
  d.choose(1);
  eq('engine: hide + scene + pause (image-only beat)', [d.view.bg?.img, d.view.layers.length, d.view.say], ['images/cg_kiss.jpg', 0, null]);
  d.advance();
  eq('engine: rejoin label', [d.view.label, say(d)], ['w1_date_end', 'Later...']);
  d.advance();
  eq('engine: continuation label', [d.view.label, say(d)], ['w1_date_part2', 'What a day.']);
  d.advance();
  eq('engine: linear jump ends the scene', d.view.ended, { reason: 'left-scene', nextLabel: 'w1_night' });
  // timeline: previous choice, else first
  const t = new PlayerEngine(programs!, scene('w1_date').labels);
  const tl1 = t.timeline();
  eq('timeline: fork at the menu, assumed', tl1.forks.map((f) => [f.i, f.chosen, f.kind]), [[2, false, 'menu']]);
  eq('timeline: assumed path takes the first choice', tl1.stops[3].view.say?.what, 'The park is lovely.');
  eq('timeline: ends where the scene does', tl1.stops.at(-1)?.view.ended, { reason: 'left-scene', nextLabel: 'w1_night' });
  t.advance(); t.advance(); t.choose(1);
  const tl2 = t.timeline();
  eq('timeline: remembers your choice', [tl2.forks[0].chosen, tl2.stops[3].view.bg?.img], [true, 'images/cg_kiss.jpg']);
  eq('timeline: position matches', [t.position, tl2.stops[t.position].view.bg?.img], [3, 'images/cg_kiss.jpg']);
  t.jumpTo(1, tl2);
  eq('jumpTo a stop', t.view.say?.what, 'Your phone buzzes.');
  t.back();
  eq('back after jumpTo', t.view.say?.what, 'Where should we go?');
  t.jumpTo(tl2.stops.length - 2, tl2);
  eq('jump near the end', t.view.say?.what, 'What a day.');
  eq('previous line kept for menus', (() => { const m = new PlayerEngine(programs!, scene('w1_date').labels); m.advance(); m.advance(); return m.previousLine?.what; })(), 'Your phone buzzes.');

  const auto = new PlayerEngine(programs!, scene('beach').labels, { autoBranch: true });
  auto.advance(); auto.advance(); auto.choose(1); // Leave
  eq('engine: autoBranch takes the first branch', [auto.view.bg?.name, auto.view.video?.img, auto.view.branch], ['bg night', 'video/ending.webm', null]);
}

// ── APK: scripts inside assets/x-game/, media in the external archive.rpa ──
{
  const apk: SourceFile = { name: 'game.apk', size: statSync(join(dir, 'game.apk')).size, lastModified: 1, blob: await openAsBlob(join(dir, 'game.apk')) };
  const both = [apk, sources[1]];
  const { index: ai, programs: ap } = await buildGalleryIndex(both);
  eq('apk source kind', ai.sources[0].kind, 'apk');
  eq('apk scripts (tl/, engine files skipped)', [ai.stats.scriptsFound, ai.stats.scriptsParsed], [5, 5]);
  eq('apk scenes', ai.scenes.map((s) => s.id), ['apk_bonus', 'from_broken_source', 'gallery_extra', 'chapter_two', 'start', 'beach', 'w1_date', 'w1_night', 'common_phone']);
  check('apk programs', !!ap && !!ap.labels['apk_bonus']);
  const bonus = ai.assets['images/bonus.png'];
  check('nested stored .rpa inside APK', !!bonus && bonus.source === 0);
  const gui = ai.assets['images/gui_deflated.png'];
  check('deflated APK image flagged', !!gui?.deflated);
  for (const ref of [bonus, gui]) {
    if (!ref) continue;
    const bytes = Buffer.from(await (await loadAssetBlob(both.map((s) => s.blob), ref)).arrayBuffer()).toString('hex');
    check(`apk asset bytes ${ref.path}`, bytes === media[ref.path]);
  }
  eq('apk show at right', ap?.labels['apk_bonus'].steps[1], { t: 'show', tag: 'images', img: 'images/gui_deflated.png', name: 'images/gui_deflated.png', pos: [1, 1] });
  const bytes = Buffer.from(await (await loadAssetBlob(both.map((s) => s.blob), ai.assets['video/intro.webm'])).arrayBuffer()).toString('hex');
  check('archive media alongside APK', bytes === media['video/intro.webm']);
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
  if (done?.type === 'done') {
    eq('worker result matches', done.index.scenes.map((s) => s.id), index.scenes.map((s) => s.id));
    check('worker sends programs', !!done.programs && Object.keys(done.programs.labels).length === 16);
  }
}

// ── images-only archive (scripts loose elsewhere) → folder mode ──
{
  const only = (await buildGalleryIndex([sources[1]])).index;
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
eq('rpy show clauses', parseRpy('label a:\n    show eileen happy at left with dissolve\n    show screen hud\n    scene\n    hide eileen with dissolve\n    return\n').flatMap((s) => (s.k === 'label' ? s.body : [])), [
  { k: 'show', name: ['eileen', 'happy'], expr: null, at: ['left'], line: 2 },
  { k: 'scene', name: null, expr: null, at: [], line: 4 },
  { k: 'hide', name: ['eileen'], line: 5 },
  { k: 'return', line: 6 },
]);
eq('rpy if/elif/else + menu conditions', JSON.stringify(parseRpy('label a:\n    if x > 1:\n        "big"\n    elif x:\n        "small"\n    else:\n        "none"\n    menu:\n        "Go" if ok:\n            jump b\n        "Stay":\n            pass\n').flatMap((s) => (s.k === 'label' ? s.body : [])).map((s) => s.k === 'if' ? s.entries.map((e) => e.cond) : s.k === 'menu' ? s.choices.map((c) => [c.text, c.cond]) : s.k)), JSON.stringify([['x > 1', 'x', 'True'], [['Go', 'ok'], ['Stay', null]]]));

console.log(`${passed} passed, ${failures.length} failed`);
for (const f of failures) console.log('  ✗ ' + f);
process.exit(failures.length ? 1 : 0);
