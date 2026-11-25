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
import { parsePyLiteral } from '../src/lib/replayGallery.ts';
import { findCalls, literalValue, splitTopLevel } from '../src/lib/pyString.ts';
import { BIG_LABEL_LINES, buildScenes, formatTitle } from '../src/lib/sceneParser.ts';
import { DiagCollector } from '../src/lib/diagScan.ts';
import { portraitCrop, subjectBox } from '../src/lib/portraitCrop.ts';
import { PyClass, PyObject } from '../src/lib/pickle.ts';
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
eq('source kinds', index.sources.map((s) => [s.kind, s.version, s.entries]), [['rpa', 'RPA-3.0', 6], ['rpa', 'RPA-3.0', 12]]);
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
eq('menu with condition', [dateMenu.choices.map((c) => [c.text, c.cond, c.to]), dateMenu.exit], [[['Park', null, 7], ['Cafe', 'affection >= 5', 9], ['Go home', null, 11]], 13]);
eq('set + hide + bg + sound + pause', programs!.labels['w1_date_cafe'].steps.map((s) => s.t), ['set', 'hide', 'bg', 'audio', 'pause', 'jump']);

// ── audio ──
const audioSteps = (label: string) => programs!.labels[label].steps.filter((s) => s.t === 'audio');
eq('play music via audio. alias', audioSteps('w1_date')[0], { t: 'audio', ch: 'music', op: 'play', files: ['audio/theme.ogg'], loop: null, fade: 0 });
eq('voice line', audioSteps('w1_date')[1], { t: 'audio', ch: 'voice', op: 'play', files: ['voice/e001.ogg'], loop: false, fade: 0 });
eq('play sound', audioSteps('w1_date_cafe')[0], { t: 'audio', ch: 'sound', op: 'play', files: ['audio/theme.ogg'], loop: null, fade: 0 });
eq('stop music fadeout', audioSteps('w1_date_part2')[0], { t: 'audio', ch: 'music', op: 'stop', files: [], loop: null, fade: 2 });
eq('renpy.music.play from Python', audioSteps('w1_night')[0], { t: 'audio', ch: 'music', op: 'play', files: ['audio/night.ogg'], loop: true, fade: 0 });
eq('channel defaults', [programs!.channels.music, programs!.channels.sound, programs!.channels.voice], [true, false, false]);
check('audio files referenced', !!index.assets['audio/night.ogg'] && index.assets['voice/e001.ogg']?.mime === 'audio/ogg');
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

// ── portraits ──
eq('portrait: named gallery file wins', chars.l?.portrait, 'images/gallery/lucy.png');
eq('portrait: sprite via image= tag', chars.e?.portrait, 'images/sprites/eileen_happy.png');
eq('portrait: fallback to a scene image', chars.j?.portrait, 'images/bg beach.png');
check('portrait candidates include the sprite for Lucy', !!chars.l?.portraitCandidates?.includes('images/lucy smile.png'));
check('portraits are in the asset table', !!index.assets['images/gallery/lucy.png'] && !!index.assets['images/sprites/eileen_happy.png']);

// ── diagnostics collected while indexing ──
{
  const d = index.diag!;
  check('diag: folders summarised', !!d && d.folders.some((f) => f.dir === 'images/gallery' && f.images === 1 && f.samples.includes('lucy.png')), JSON.stringify(d?.folders.map((f) => f.dir)));
  check('diag: every script listed', d.scripts.length === index.stats.scriptsFound && d.scripts.every((x) => x.how !== 'failed'), JSON.stringify(d.scripts));
  check('diag: replay screen found', d.screens.some((x) => x.name === 'replay_gallery'), JSON.stringify(d.screens));
  check('diag: Replay actions found inside the screen', d.replay.filter((r) => r.screen === 'replay_gallery' && r.text.startsWith('Replay(')).length === 2, JSON.stringify(d.replay));
  check('diag: Gallery code found', d.replay.some((r) => r.text.includes('unlock_image("bg beach")')), JSON.stringify(d.replay));
}

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
for (const lp of Object.values(programs!.labels)) for (const st of lp.steps) {
  if ((st.t === 'bg' || st.t === 'show' || st.t === 'video') && st.img) referenced.add(st.img);
  if (st.t === 'audio') st.files.forEach((f) => referenced.add(f));
}
for (const c of index.characters) c.portraitCandidates?.forEach((p) => referenced.add(p));
eq('asset table = scene media + player images + audio + portraits', Object.keys(index.assets).sort(), [...referenced].sort());
check('music referenced for the player', !!index.assets['audio/theme.ogg']);
for (const [path, ref] of Object.entries(index.assets)) {
  const bytes = Buffer.from(await (await loadAssetBlob(sources.map((s) => s.blob), ref)).arrayBuffer()).toString('hex');
  check(`asset bytes ${path}`, bytes === media[path]);
  check(`asset mime ${path}`, ref.mime === (path.endsWith('.webm') ? 'video/webm' : path.endsWith('.jpg') ? 'image/jpeg' : path.endsWith('.webp') ? 'image/webp' : path.endsWith('.ogg') ? 'audio/ogg' : 'image/png'));
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

  // audio state through a scene
  const au = new PlayerEngine(programs!, scene('w1_date').labels);
  eq('engine audio: music + voice at the first line', [au.view.audio.music?.files, au.view.audio.music?.loop, au.view.audio.voice?.files], [['audio/theme.ogg'], true, ['voice/e001.ogg']]);
  au.advance();
  eq('engine audio: voice stops on tap, music continues', [!!au.view.audio.voice, au.view.audio.music?.files], [false, ['audio/theme.ogg']]);
  au.advance(); au.choose(1);
  eq('engine audio: sound effect at the image beat', [au.view.audio.sound?.files, au.view.audio.sound?.done], [['audio/theme.ogg'], undefined]);
  au.advance();
  eq('engine audio: one-shot marked played, not restarted', au.view.audio.sound?.done, true);
  au.advance();
  eq('engine audio: stop music', au.view.audio.music, undefined);
  const auTl = au.timeline();
  au.jumpTo(0, auTl);
  eq('engine audio: jumping back restores music + voice', [au.view.audio.music?.files, au.view.audio.voice?.files], [['audio/theme.ogg'], ['voice/e001.ogg']]);

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
  eq('folder stats', [only.stats.scriptsFound, only.stats.images, only.stats.videos, only.stats.audio], [0, 6, 3, 3]);
  eq('folder scenes', only.scenes.map((s) => [s.id, s.title, s.images.length, s.videos.length]), [
    ['images', 'Top level', 3, 0],
    ['images/bg', 'Bg', 1, 0],
    ['images/gallery', 'Gallery', 1, 0],
    ['images/sprites', 'Sprites', 1, 0],
    ['video', 'Video', 0, 3],
  ]);
  eq('folder categories', only.characters.map((c) => [c.name, c.sceneCount]), [['Bg', 1], ['Gallery', 1], ['Sprites', 1], ['Top level', 1], ['Video', 1]]);
  eq('folder thumbnail prefers video', only.scenes[4].thumbnail, { path: 'video/ending.webm', kind: 'video' });
  check('folder assets referenced', Object.keys(only.assets).length === 9);
  eq('scripts mode stats', [index.mode, index.stats.scriptsFound, index.stats.images], ['scripts', 4, 6]);
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

// ── Big casts: narrators, same-name variants, roles, big branch labels, portrait matching ──
{
  const lines = (who: string, n: number, tag: string) => Array.from({ length: n }, (_, i) => `    ${who} "${tag} ${i}"`).join('\n');
  const chars = ['define bla = Character(None, what_color="#fff")', 'define mc = Character("[player]")', 'define mct = Character("[player]", what_italic=True)',
    'define d = Character("Dalia", color="#f60")', 'define dsc = Character("Dalia")', 'define x = Character("Alex")', 'define no = Character("Nova")', 'define bro = Character("Brock")'];
  for (let i = 0; i < 9; i++) chars.push(`define m${i} = Character("Minor ${String.fromCharCode(65 + i)}")`);
  let src = chars.join('\n') + '\n';
  // 12 scenes; mc in all of them, Dalia leads most.
  for (let k = 0; k < 12; k++) src += `label s${k}:\n    scene bg room${k}\n${lines('mc', 3, `mc${k}`)}\n${lines('mct', 1, `t${k}`)}\n${lines('d', 40, `d${k}`)}\n${lines('bla', 2, `n${k}`)}\n    m${k % 9} "minor line"\n    return\n`;
  // A menu that jumps to a big date (its own scene) and a small branch (merged).
  src += `label sat:\n    mc "Where to?"\n    menu:\n        "Gym":\n            jump gym\n        "Stay":\n            jump stay\nlabel gym:\n${lines('x', BIG_LABEL_LINES, 'g')}\n    return\nlabel stay:\n    x "Fine."\n    return\n`;
  src += `label dsc_scene:\n${lines('dsc', 5, 'p')}\n${lines('no', 80, 'n')}\n    return\n`;
  const paths = ['images/bios/lk_dalia0.webp', 'images/gallery/ga_dalia1.jpg', 'images/gallery/ga_alexdalia.jpg', 'images/gallery/ga_alex1.jpg', 'images/lock/lock_pick_broken.png',
    'images/MENUS/e_brows.png', 'gui/sp2/alex_d.png', 'images/02/white.webp', 'images/ga_nova1.png', ...Array.from({ length: 12 }, (_, k) => `images/bg room${k}.jpg`)];
  const lookup = { paths: () => paths, resolve: (f: string) => paths.find((p) => p.toLowerCase() === f.toLowerCase()) ?? null };
  const r = buildScenes([{ path: 'game/script.rpy', stmts: parseRpy(src) }], lookup as never);
  const byId = Object.fromEntries(r.characters.map((c) => [c.id, c]));
  check('nameless Character(None) is narration, not a character', !byId.bla && !r.characters.some((c) => c.name === 'bla'));
  check('same-name variants merge (mct into mc, dsc into d)', !byId.mct && byId.mc?.aliases?.includes('mct') === true && byId.d?.aliases?.includes('dsc') === true && !byId.dsc, JSON.stringify(r.characters.map((c) => c.id)));
  eq('merged line counts add up', byId.d?.lineCount, 12 * 40 + 5);
  check('merged ids rewritten in scenes', r.scenes.find((s) => s.id === 'dsc_scene')?.characters.includes('d') === true);
  eq('player character detected', byId.mc?.role, 'protagonist');
  check('main cast vs minor characters', byId.d?.role === 'main' && byId.x?.role === 'main' && byId.no?.role === 'main' && byId.m0?.role === 'minor', JSON.stringify(r.characters.map((c) => [c.id, c.role, c.lineCount])));
  check('big label picked from a menu is its own scene', r.scenes.some((s) => s.id === 'gym') && r.scenes.find((s) => s.id === 'sat')?.labels.includes('stay') === true, JSON.stringify(r.scenes.filter((s) => /sat|gym|stay/.test(s.id)).map((s) => s.labels)));
  eq('portrait: bios beats gallery, no substring matches', byId.d?.portrait, 'images/bios/lk_dalia0.webp');
  check('portrait candidates skip UI art and blank screens', !r.characters.some((c) => c.portraitCandidates?.some((p) => /lock|MENUS|gui\/|white/.test(p))), JSON.stringify(r.characters.map((c) => [c.id, c.portraitCandidates])));
  check('short variable names do not match files', !byId.bro?.portraitCandidates?.includes('images/lock/lock_pick_broken.png'));
  eq('portrait: whole word in gallery file', byId.x?.portrait, 'images/gallery/ga_alex1.jpg');
  check('channels: no loop argument loops', (() => {
    const r2 = buildScenes([{ path: 'game/a.rpy', stmts: parseRpy('init python:\n    renpy.music.register_channel("music", "music")\n    renpy.music.register_channel("sfx2", "sfx", False)\n    renpy.music.register_channel("amb", "sfx", loop=True)\nlabel a:\n    "x"\n') }], lookup as never);
    return r2.programs.channels.music === true && r2.programs.channels.sfx2 === false && r2.programs.channels.amb === true;
  })());
}

// ── Diagnostics: gallery code capture ──
{
  const node = (cls: string, attrs: Record<string, unknown>) => {
    const o = new PyObject(new PyClass(cls.includes('SL') ? 'renpy.sl2.slast' : 'renpy.ast', cls));
    for (const [k, v] of Object.entries(attrs)) o.attrs.set(k, v);
    return o;
  };
  const tree = [
    node('Init', { block: [node('Python', { code: 'replays = [("Annie", "ga_annie1", "ga_annie1_label", 1)]' })] }),
    node('Screen', { screen: node('SLScreen', { name: 'filter_girl', children: [node('SLDisplayable', { keyword: [['action', 'SetVariable("girl", "annie")']] })] }) }),
    node('Label', { name: 'ga_annie1_label', block: [node('Say', { who: 'a', what: 'secret dialogue' })] }),
  ];
  const dc = new DiagCollector();
  dc.scanTree('game/gallery.rpyc', tree);
  const code = dc.code[0]?.strings ?? [];
  check('diag code: gallery data and screens kept in order', code.includes('replays = [("Annie", "ga_annie1", "ga_annie1_label", 1)]') && code.indexOf('«screen filter_girl»') < code.indexOf('SetVariable("girl", "annie")'), JSON.stringify(code));
  check('diag code: labels and dialogue left out', !code.includes('secret dialogue') && !code.includes('ga_annie1_label'), JSON.stringify(code));
  dc.scanTree('game/script.rpyc', tree);
  eq('diag code: only gallery-ish files', dc.code.length, 1);
}

// ── Portrait framing ──
{
  const W = 192, H = 108;
  const img = (fill: (x: number, y: number) => [number, number, number, number]) => {
    const px = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) px.set(fill(x, y), (y * W + x) * 4);
    return px;
  };
  // Transparent canvas, figure at x 140..169, y 12..107 (full body, far right).
  const cut = img((x, y) => (x >= 140 && x < 170 && y >= 12 ? [200, 60, 120, 255] : [0, 0, 0, 0]));
  const box = subjectBox(cut, W, H);
  eq('subject found on a transparent canvas', box, { x: 140, y: 12, w: 30, h: 96 });
  const crop = portraitCrop(box, W, H);
  check('crop is 3:4 around the figure, from the top', Math.abs(crop.w / crop.h - 0.75) < 0.03 && crop.x <= 140 && crop.x + crop.w >= 170 && crop.y <= 12 && crop.y + crop.h < H, JSON.stringify(crop));
  // Plain black background (an opaque render).
  const black = img((x, y) => (x >= 20 && x < 60 && y >= 30 ? [240, 200, 180, 255] : [0, 0, 0, 255]));
  eq('subject found on a plain background', subjectBox(black, W, H), { x: 20, y: 30, w: 40, h: 78 });
  // A busy scene: no plain background → centred crop of the whole height.
  const busy = img((x, y) => [(x * 7) % 256, (y * 13) % 256, ((x + y) * 5) % 256, 255]);
  eq('busy picture has no subject box', subjectBox(busy, W, H), null);
  eq('busy picture: centred full-height crop', portraitCrop(null, W, H), { x: 56, y: 0, w: 81, h: 108 });
}

// ── Replay gallery ──
{
  const g = index.gallery;
  check('gallery found', !!g, JSON.stringify(g));
  eq('gallery: list rows first, then literal screen buttons', g?.replays.map((r) => [r.label, r.title]), [['beach', 'Beach Day'], ['w1_date_park', 'Park Walk'], ['w1_date', 'Beach date']]);
  eq('gallery: thumbnails prefer the gallery folder', g?.replays.map((r) => r.thumb), ['images/gallery/lucy.png', 'images/cg_kiss.jpg', null]);
  eq('gallery: groups in the dict order with display names, matched to characters', g?.groups, [{ key: 'eileen', name: 'Eileen', char: 'e' }, { key: 'lucy', name: 'Lucy', char: 'l' }]);
  eq('gallery: who is in each replay', g?.replays.map((r) => r.chars), [['l'], ['e', 'l'], []]);
  eq('gallery: replay inside a merged scene knows its scene', g?.replays[1].scene, 'w1_date');
  check('gallery thumbnails are in the asset table', !!index.assets['images/gallery/lucy.png'] && !!index.assets['images/cg_kiss.jpg']);
  eq('py literal: nesting, _(), tuples, comments, concatenation', parsePyLiteral('[("a" "b", _(\'c\'), 1, -2.5, None, True), # x\n {"k": [u"v"]},]'), [['ab', { tr: 'c' }, 1, -2.5, null, true], { dict: [['k', ['v']]] }]);
  eq('py literal: not a literal', parsePyLiteral('[Heart(1, 2)]'), undefined);
}

// ── Replays end at renpy.end_replay() ──
{
  const progs = { schema: 1 as const, stage: null, speakers: {}, channels: {}, labels: {
    ga: { file: 'a', next: null, steps: [{ t: 'say', who: null, what: 'one' }, { t: 'replayEnd' }, { t: 'say', who: null, what: 'after the replay' }] as Step[] },
  } };
  const replay = new PlayerEngine(progs, ['ga'], { replay: true });
  replay.advance();
  check('replay ends at end_replay', !!replay.view.ended && replay.view.say?.what !== 'after the replay');
  const normal = new PlayerEngine(progs, ['ga']);
  normal.advance();
  eq('normal play continues past end_replay', normal.view.say?.what, 'after the replay');
}

console.log(`${passed} passed, ${failures.length} failed`);
for (const f of failures) console.log('  ✗ ' + f);
process.exit(failures.length ? 1 : 0);
