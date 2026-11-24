/**
 * End-to-end UI test in a phone-sized headless Chromium.
 *
 *   node tests/ui/build-test.mjs /tmp/uibuild <node_modules dirs…>
 *   node tests/ui/ui-test.mjs /tmp/uibuild <fixture dir with scripts.rpa + images.rpa> <screenshot dir> [playwright module path]
 */
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { extname, join } from 'node:path';

const [buildDir, fixtures, shots, pwPath = 'playwright'] = process.argv.slice(2);
const { chromium } = createRequire(import.meta.url)(pwPath);
mkdirSync(shots, { recursive: true });

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.ts': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };
const server = createServer((req, res) => {
  const p = join(buildDir, decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/\/$/, '/index.html'));
  if (!existsSync(p)) return res.writeHead(404).end();
  res.writeHead(200, { 'content-type': MIME[extname(p)] ?? 'application/octet-stream' }).end(readFileSync(p));
}).listen(0);
const url = `http://127.0.0.1:${server.address().port}/`;

let passed = 0;
const failures = [];
const check = (name, ok, detail = '') => (ok ? passed++ : failures.push(`${name}${detail ? `: ${detail}` : ''}`));

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, acceptDownloads: true });
// Count live object URLs to prove they are revoked.
await context.addInitScript(() => {
  const live = new Set();
  const create = URL.createObjectURL.bind(URL);
  const revoke = URL.revokeObjectURL.bind(URL);
  URL.createObjectURL = (b) => { const u = create(b); live.add(u); return u; };
  URL.revokeObjectURL = (u) => { live.delete(u); revoke(u); };
  window.__liveUrls = () => live.size;
  // Real full screen resizes the headless window mid-test; the feature isn't under test here.
  Element.prototype.requestFullscreen = () => Promise.reject(new Error('disabled in tests'));
});
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

const files = [join(fixtures, 'scripts.rpa'), join(fixtures, 'images.rpa')];
const cards = page.locator('[data-scene]');
/** Search results update one render later (useDeferredValue): wait for the grid to settle. */
const cardsSettle = (n) => page.waitForFunction((want) => document.querySelectorAll('[data-scene]').length === want, n, { timeout: 5000 }).catch(() => {});

// ── Welcome ──
await page.goto(url);
await page.getByText("Browse Ren'Py scenes").waitFor();
await page.screenshot({ path: join(shots, '1-welcome.png') });
check('welcome renders', true);

// ── Open both archives → index in worker → grid ──
const t0 = Date.now();
await page.locator('input[type=file]').first().setInputFiles(files);
const charCards = page.locator('[data-character]');
await charCards.first().waitFor({ timeout: 20000 });
console.log(`  indexing + characters screen: ${Date.now() - t0} ms`);
check('characters screen first', (await page.locator('[data-all-scenes]').count()) === 1 && (await charCards.count()) === 7, `cards=${await charCards.count()}`);
await page.waitForFunction(() => ['l', 'e'].every((id) => { const i = document.querySelector(`[data-character="${id}"] img`); return i && i.naturalWidth > 0; }), null, { timeout: 20000 }).catch(() => {});
check('portraits load (gallery file + sprite)', (await page.locator('[data-character="l"] img').count()) === 1 && (await page.locator('[data-character="e"] img').count()) === 1);
check('misc tile for scenes without characters', (await page.locator(`[data-character="__misc__"]`).innerText()).includes('2 scenes'));
await page.screenshot({ path: join(shots, '1b-characters.png') });

// character page, back button, Android back
await page.locator('[data-character="l"]').click();
await cards.first().waitFor();
check('character page lists their scenes', (await cards.count()) === 2 && (await page.locator('[data-character-header]').innerText()).includes('Lucy'));
await page.screenshot({ path: join(shots, '1c-character-page.png') });
await page.getByRole('button', { name: 'Change portrait' }).click();
await page.locator('[data-portrait-picker]').waitFor();
check('portrait picker offers choices', (await page.locator('[data-portrait-choice]').count()) >= 3);
await page.locator('[data-portrait-choice]').nth(1).click();
const savedPortrait = await page.evaluate(() => Object.entries(localStorage).find(([k]) => k.startsWith('rpa.portraits.'))?.[1] ?? '');
check('portrait choice remembered', savedPortrait.includes('"l"'), savedPortrait);
await page.getByLabel('Back to characters').click();
await page.locator('[data-all-scenes]').waitFor();
check('back to characters', (await cards.count()) === 0);
await page.locator('[data-character="e"]').click();
await cards.first().waitFor();
await page.goBack();
await page.locator('[data-all-scenes]').waitFor({ timeout: 5000 }).catch(() => {});
check('Android back returns to characters', (await page.locator('[data-all-scenes]').count()) === 1);
await page.locator('[data-all-scenes]').click();
await cards.first().waitFor({ timeout: 20000 });
check('indexed in worker', (await cards.count()) === 8, `cards=${await cards.count()}`);
check('subtitle', /8 scenes · 6 characters/.test(await page.locator('header').innerText()), await page.locator('header').innerText());
console.log(`  indexing + first paint: ${Date.now() - t0} ms`);

// Thumbnails: 7 of the 8 scenes have media (common_phone is text only); some come from video frames.
await page.waitForFunction(() => {
  const imgs = [...document.querySelectorAll('[data-scene] img')];
  return imgs.length === 7 && imgs.every((i) => i.complete && i.naturalWidth > 0);
}, null, { timeout: 30000 }).catch(() => {});
const thumbCount = await page.locator('[data-scene] img').count();
check('all thumbnails generated', thumbCount === 7, `thumbs=${thumbCount}`);
check('duration badge', /~?\d+ min|<1 min/.test(await page.locator('[data-scene="w1_date"]').innerText()));
const startThumb = await page.locator('[data-scene="start"] img').getAttribute('src');
check('video thumbnail is a JPEG frame', startThumb?.startsWith('data:image/jpeg') ?? false);
check('badges', (await page.locator('[data-scene="start"]').innerText()).includes('VIDEO') && (await page.locator('[data-scene="chapter_two"]').innerText()).includes('1 IMAGE'));
await page.screenshot({ path: join(shots, '2-grid.png') });

// ── Character filter ──
await page.getByRole('button', { name: /^Lucy\b/ }).first().click();
check('filter by Lucy', (await cards.count()) === 2 && (await cards.first().getAttribute('data-scene')) === 'beach', `cards=${await cards.count()}`);
await page.screenshot({ path: join(shots, '3-filter.png') });
await page.getByRole('button', { name: /^All\b/ }).click();
check('filter cleared', (await cards.count()) === 8);

// ── Sort by estimated time ──
await page.getByRole('radio', { name: 'Longest' }).click();
check('sort longest first', (await cards.first().getAttribute('data-scene')) === 'beach', await cards.first().getAttribute('data-scene'));
await page.getByRole('radio', { name: 'Shortest' }).click();
check('sort shortest first', (await cards.first().getAttribute('data-scene')) === 'common_phone', await cards.first().getAttribute('data-scene'));
await page.getByRole('radio', { name: 'Story order' }).click();

// ── Search ──
await page.getByPlaceholder('Search scenes or characters').fill('jun');
await cardsSettle(1);
check('search by character name', (await cards.count()) === 1 && (await cards.first().getAttribute('data-scene')) === 'chapter_two');
await page.getByPlaceholder('Search scenes or characters').fill('beach');
await cardsSettle(1);
check('search by title', (await cards.count()) === 1, `cards=${await cards.count()}`);
await page.getByPlaceholder('Search scenes or characters').fill('zzzz');
await page.getByText('No scenes match.').waitFor();
await page.getByRole('button', { name: 'Clear filters' }).click();
await cardsSettle(8);
check('empty result offers Clear filters', (await cards.count()) === 8, `cards=${await cards.count()}`);
await page.getByPlaceholder('Search scenes or characters').fill('a');
await page.getByLabel('Clear search').click();

// ── Preview sheet: video, swipe to images, save ──
await page.locator('[data-scene="beach"]').click();
const dialog = page.getByRole('dialog');
await dialog.waitFor();
const video = dialog.locator('video');
await video.waitFor();
const canPlay = await video.evaluate((v) => new Promise((r) => (v.readyState >= 1 ? r(true) : (v.onloadedmetadata = () => r(true), v.onerror = () => r(false)))));
check('video streams from sliced blob', canPlay === true);
check('dialogue shown', (await dialog.innerText()).includes('Hi') && (await dialog.innerText()).includes('▸ Kiss'));
check('media index strip', (await dialog.locator('[data-media-strip] [role=tab]').count()) === 5);
await page.screenshot({ path: join(shots, '4-preview-video.png') });

const [download] = await Promise.all([page.waitForEvent('download'), dialog.getByRole('button', { name: /Save file/ }).click()]);
check('save downloads the video', download.suggestedFilename() === 'ending.webm', download.suggestedFilename());
const saved = await download.path().then((p) => readFileSync(p));
check('saved bytes are the real file', saved.subarray(0, 4).toString('hex') === '1a45dfa3' && saved.length > 50000, `${saved.length}`);

// Swipe left twice: video 2 → first image
const viewer = dialog.locator('.aspect-video');
for (let n = 0; n < 2; n++) {
  await dialog.getByLabel('Next').click();
}
const img = dialog.locator('.aspect-video img');
await img.waitFor();
await page.waitForFunction(() => { const i = document.querySelector('[role=dialog] .aspect-video img'); return i && i.complete && i.naturalWidth > 0; });
check('image viewer', (await dialog.innerText()).includes('bg beach.png'));
await viewer.dispatchEvent('touchstart', { touches: [{ identifier: 1, clientX: 300, clientY: 200 }], changedTouches: [{ identifier: 1, clientX: 300, clientY: 200 }] }).catch(() => {});
await page.screenshot({ path: join(shots, '5-preview-image.png') });

// Back button closes the sheet, not the app
await page.goBack();
await dialog.waitFor({ state: 'detached' });
check('back button closes preview', (await page.getByRole('dialog').count()) === 0 && (await cards.count()) === 8);
await page.waitForTimeout(300);
const live = await page.evaluate(() => window.__liveUrls());
check('all object URLs revoked', live === 0, `live=${live}`);

// ── Reopen same files: instant from IndexedDB, thumbnails cached ──
await page.reload();
await page.getByText('Recently opened').waitFor();
await page.screenshot({ path: join(shots, '6-welcome-recent.png') });
await page.getByRole('button', { name: 'Clear all' }).click();
check('clear all asks to confirm', (await page.getByRole('button', { name: 'Confirm clear?' }).count()) === 1);
await page.waitForTimeout(3300);
check('confirmation resets itself', (await page.getByRole('button', { name: 'Clear all' }).count()) === 1);
const t1 = Date.now();
await page.locator('input[type=file]').first().setInputFiles(files);
await page.locator('[data-all-scenes]').waitFor();
await page.locator('[data-all-scenes]').click();
await cards.first().waitFor();
check('reopen uses cache', (await page.locator('header').innerText()).includes('cached'));
console.log(`  cached reopen: ${Date.now() - t1} ms`);

// ── Open from the recent list without files: dialogue + cached thumbs ──
await page.getByLabel('Home').click();
await page.getByText('Recently opened').waitFor();
await page.locator('main li button').first().click();
await page.locator('[data-all-scenes]').waitFor();
await page.locator('[data-all-scenes]').click();
await cards.first().waitFor();
check('cache-only banner', (await page.getByText('Opened from the cache').count()) === 1);
check('banner can re-attach files', (await page.getByRole('button', { name: 'Select the archive files again' }).count()) === 1);
await page.waitForFunction(() => document.querySelectorAll('[data-scene] img').length === 7, null, { timeout: 10000 }).catch(() => {});
check('thumbnails from IndexedDB without files', (await page.locator('[data-scene] img').count()) === 7);
await page.locator('[data-scene="start"]').click();
check('preview asks for files', (await page.getByRole('dialog').innerText()).includes('Select files'));
check('play needs files', await page.getByRole('dialog').getByRole('button', { name: /Play scene/ }).isDisabled());
await page.screenshot({ path: join(shots, '7-cache-only.png') });

// ── Images-only archive (scripts kept loose elsewhere): folder mode + guidance ──
await page.keyboard.press('Escape');
await page.getByRole('dialog').waitFor({ state: 'detached' });
await page.locator('input[type=file]').first().setInputFiles([join(fixtures, 'images.rpa')]);
await page.getByText('No game scripts in images.rpa').waitFor({ timeout: 20000 });
check('folder mode notice', (await page.locator('main').innerText()).includes('6 images · 3 videos · 3 audio files'));
check('folder cards', (await cards.count()) === 5, `cards=${await cards.count()}`);
check('folder subtitle', /5 folders · 9 files/.test(await page.locator('header').innerText()));
await page.waitForFunction(() => document.querySelectorAll('[data-scene] img').length === 5, null, { timeout: 20000 }).catch(() => {});
await page.screenshot({ path: join(shots, '8-folder-mode.png') });
await page.locator('[data-scene="video"]').click();
check('folder preview has no dialogue list', (await page.getByRole('dialog').innerText()).includes('Folder view: 0 images, 3 videos'));
await page.keyboard.press('Escape');

// ── APK + archive.rpa from different folders: open the archive, then add the APK ──
await page.getByRole('button', { name: 'Add the APK or script files' }).waitFor();
const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: 'Add the APK or script files' }).click()]);
await chooser.setFiles([join(fixtures, 'game.apk')]);
await page.locator('[data-all-scenes]').waitFor({ timeout: 20000 });
await page.locator('[data-all-scenes]').click();
await page.locator('[data-scene="apk_bonus"]').waitFor({ timeout: 20000 });
check('adding the APK keeps the archive', (await page.locator('main').innerText()).includes('images.rpa') && (await page.locator('main').innerText()).includes('game.apk'));
check('apk opens with scenes', (await cards.count()) === 9, `cards=${await cards.count()}`);
await page.waitForFunction(() => { const i = document.querySelector('[data-scene="apk_bonus"] img'); return i && i.naturalWidth > 0; }, null, { timeout: 15000 }).catch(() => {});
check('thumbnail from image inside APK', (await page.locator('[data-scene="apk_bonus"] img').count()) === 1);

// ── Scene player ──
const player = page.locator('[data-player]');
const sayText = () => player.locator('[data-say]').innerText().catch(() => null);
const tap = async () => { await player.click({ position: { x: 500, y: 250 } }); await page.waitForTimeout(80); };
const tapLeftEdge = async () => { await player.click({ position: { x: 40, y: 250 } }); await page.waitForTimeout(80); };
await page.setViewportSize({ width: 844, height: 390 }); // landscape phone
await page.locator('[data-scene="w1_date"]').click();
await page.getByRole('dialog').getByRole('button', { name: /Play scene/ }).click();
await player.waitFor();
await page.waitForFunction(() => [...document.querySelectorAll('[data-player] img')].some((i) => i.naturalWidth > 0 && getComputedStyle(i).opacity !== '0'), null, { timeout: 10000 }).catch(() => {});
check('player shows first line', (await sayText()) === 'Where should we go?', String(await sayText()));
check('player speaker name', (await player.locator('[data-speaker]').innerText()) === 'Eileen');
check('first-run back hint', (await player.locator('[data-back-hint]').count()) === 1);
await player.getByRole('button', { name: 'Player settings' }).click();
check('use as portrait for the speaker', (await player.locator('[data-use-portrait]').innerText()).includes("Eileen's portrait"));
await page.keyboard.press('Escape');
const layout = await page.evaluate(() => [...document.querySelectorAll('[data-player] img')].map((i) => { const r = i.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]; }));
check('stage fills the landscape screen (1280×720 → 693×390)', layout.length === 2 && layout[0][2] === 693 && layout[0][3] === 390, JSON.stringify(layout));
check('sprite placed at left', layout[1]?.[0] === layout[0]?.[0], JSON.stringify(layout));
check('one fork dot on the timeline (assumed)', (await player.locator('[data-fork="assumed"]').count()) === 1);
const audioState = () => page.evaluate(() => Object.fromEntries([...document.querySelectorAll('[data-player] audio')].map((a) => [a.dataset.channel, { playing: !a.paused, src: a.currentSrc }])));
check('sound is off by default', (await player.locator('[data-sound="off"]').count()) === 1 && Object.keys(await audioState()).length === 0);
await page.screenshot({ path: join(shots, '9-player.png') });
await player.getByRole('button', { name: 'Turn sound on' }).click();
await page.waitForFunction(() => { const a = document.querySelector('[data-player] audio[data-channel="music"]'); return a && !a.paused && a.currentTime > 0; }, null, { timeout: 8000 }).catch(() => {});
const a1 = await audioState();
check('one tap: music plays', a1.music?.playing === true, JSON.stringify(a1));
check('voice line plays', a1.voice?.playing === true, JSON.stringify(a1));
await tap();
await page.waitForTimeout(400);
const a2 = await audioState();
check('scrubber counter', /^\d+\/\d+$/.test(await player.locator('[data-scrub-counter]').innerText()));
await player.getByRole('button', { name: 'Sound settings' }).click();
check('sound menu opens', (await player.locator('[data-sound-menu]').count()) === 1);
const beforeOutside = await sayText();
await tap();
check('outside tap closes the menu without advancing', (await player.locator('[data-sound-menu]').count()) === 0 && (await sayText()) === beforeOutside, String(await sayText()));
await player.getByRole('button', { name: 'Hide controls' }).click();
check('hide controls', (await player.getByLabel('Close player').count()) === 0 && (await player.locator('[data-say]').count()) === 0);
await page.screenshot({ path: join(shots, '9b-player-hud-hidden.png') });
await tap();
check('tap brings controls back without advancing', (await player.getByLabel('Close player').count()) === 1 && (await sayText()) === beforeOutside);
check('voice stops on tap, music continues', a2.voice?.playing === false && a2.music?.playing === true && a2.music.src === a1.music.src, JSON.stringify(a2));
check('player follows call into shared label', (await sayText()) === 'Your phone buzzes.', String(await sayText()));
await tapLeftEdge();
check('tap left edge goes back', (await sayText()) === 'Where should we go?', String(await sayText()));
await tap();
await tap();

// Menu: the question + what each choice leads to
const menuText = await player.innerText();
check('menu shows the question', (await player.locator('[data-question]').innerText()).includes('Your phone buzzes.'));
check('three choices', (await player.locator('[data-choice]').count()) === 3);
const choiceTexts = await player.locator('[data-choice]').allInnerTexts();
check('park: rejoins + change + checked later', choiceTexts[0].includes('Rejoins after 1 line') && choiceTexts[0].includes('Eileen love +1') && choiceTexts[0].includes('Eileen love is checked in W 1 Night'), choiceTexts[0]);
check('cafe: requirement, new image, changes', choiceTexts[1].includes('requires affection >= 5') && choiceTexts[1].includes('Rejoins after 1 image') && choiceTexts[1].includes('1 new image') && choiceTexts[1].includes('Lucy love +2') && choiceTexts[1].includes('add_points("lucy", 1)'), choiceTexts[1]);
check('go home: continues to another scene', choiceTexts[2].includes('Continues: W 1 Night'), choiceTexts[2]);
await player.getByRole('button', { name: 'Player settings' }).click();
await player.locator('[data-settings-menu]').getByRole('button', { name: 'Choice hints' }).click();
check('choice hints can be turned off', (await player.locator('[data-choice-info]').count()) === 0);
await player.locator('[data-settings-menu]').getByRole('button', { name: 'Choice hints' }).click();
await page.keyboard.press('Escape');
check('Escape closes the settings menu first', (await player.locator('[data-settings-menu]').count()) === 0 && (await player.count()) === 1);
check('choice hints back on', (await player.locator('[data-choice-info]').count()) === 3);
await page.screenshot({ path: join(shots, '10-player-menu.png') });
await player.locator('[data-choice]').nth(1).click();
await page.waitForTimeout(150);
check('image-only beat waits for a tap', (await player.locator('[data-say]').count()) === 0);
check('your choice fills the fork dot', (await player.locator('[data-fork="chosen"]').count()) === 1);
await tap();
check('rejoin label', (await sayText()) === 'Later...', String(await sayText()));
await player.getByLabel('Back one line').click();
check('back one line', (await player.locator('[data-say]').count()) === 0);

// Previous/next choice buttons and the scrubber
await player.getByLabel('Previous choice').click();
check('previous choice jumps to the menu', (await player.locator('[data-choice]').count()) === 3);
await player.getByLabel('Next choice').isDisabled();
const bar = await player.locator('[data-scrubber]').boundingBox();
await page.mouse.move(bar.x + 2, bar.y + bar.height / 2);
await page.mouse.down();
await page.mouse.move(bar.x + bar.width * 0.35, bar.y + bar.height / 2, { steps: 4 });
check('scrub preview shows the line', (await player.locator('[data-scrub-preview]').count()) === 1);
await page.screenshot({ path: join(shots, '11-player-scrub.png') });
await page.mouse.move(bar.x + bar.width - 1, bar.y + bar.height / 2, { steps: 4 });
await page.mouse.up();
await page.waitForTimeout(150);
check('scrubbing to the end shows the end screen', (await player.locator('[data-ended]').count()) === 1);
await player.getByLabel('Close player').isVisible();

// Scene log: jump to any line
if (await player.locator('[data-ended]').count()) await player.locator('[data-ended]').getByRole('button', { name: 'Replay' }).click();
await player.getByLabel('Scene log').click();
await player.locator('[data-history]').waitFor();
check('log lists the scene', (await player.locator('[data-log-line]').count()) >= 6);
await page.keyboard.press('Escape');
check('Escape closes the log before the player', (await player.locator('[data-history]').count()) === 0 && (await player.count()) === 1);
await player.getByLabel('Scene log').click();
await player.locator('[data-history-backdrop]').click({ position: { x: 20, y: 200 } });
check('tapping outside the log closes it', (await player.locator('[data-history]').count()) === 0);
await player.getByLabel('Scene log').click();
await page.screenshot({ path: join(shots, '12-player-log.png') });
await player.locator('[data-log-line]', { hasText: 'What a day.' }).click();
check('log jump', (await sayText()) === 'What a day.', String(await sayText()));
await tap();
await player.locator('[data-ended]').waitFor();
check('end of scene offers next scene', (await player.locator('[data-ended]').innerText()).includes('Continue: W 1 Night'));
await player.getByRole('button', { name: /Continue: W 1 Night/ }).click();
await page.waitForTimeout(150);
check('continues into the next scene', (await sayText()) === 'Your phone buzzes.', String(await sayText()));
await page.waitForFunction((prev) => { const a = document.querySelector('[data-player] audio[data-channel="music"]'); return a && !a.paused && a.currentSrc !== prev; }, a1.music.src, { timeout: 8000 }).catch(() => {});
const a3 = await audioState();
check('next scene switches the music track', a3.music?.playing === true && a3.music.src !== a1.music.src, JSON.stringify(a3));
check('sound setting remembered', (await player.locator('[data-sound="on"]').count()) === 1);
await tap();
const branchTexts = await player.locator('[data-branch]').allInnerTexts();
check('if picker explains what it depends on', branchTexts[0]?.includes('eileen_love >= 1') && branchTexts[0]?.includes('Eileen love: +1 by choosing “Park” in W 1 Date'), JSON.stringify(branchTexts));
await page.screenshot({ path: join(shots, '13-player-branch.png') });
await player.getByLabel('Close player').click();
await player.waitFor({ state: 'detached' });
check('closing the player returns to its scene', (await page.getByRole('dialog').innerText()).includes('W 1 Night'));
await page.goBack();
await page.getByRole('dialog').waitFor({ state: 'detached' });
await page.waitForTimeout(300);
const liveAfterPlayer = await page.evaluate(() => window.__liveUrls());
check('player revokes its object URLs', liveAfterPlayer === 0, `live=${liveAfterPlayer}`);

// Looping Movie background + cutscene + Android back closes the player
await page.locator('[data-scene="start"]').click();
await page.getByRole('dialog').getByRole('button', { name: /Play scene/ }).click();
await player.waitFor();
await page.waitForFunction(() => { const v = document.querySelector('[data-player] video'); return v && v.readyState >= 2; }, null, { timeout: 10000 }).catch(() => {});
check('Movie image plays as looping background', await page.evaluate(() => { const v = document.querySelector('[data-player] video'); return !!v && v.loop && v.readyState >= 2; }));
await page.goBack();
await player.waitFor({ state: 'detached' });
check('back button closes the player first', (await page.getByRole('dialog').count()) === 1);
await page.keyboard.press('Escape');
await page.setViewportSize({ width: 390, height: 844 });

// ── Desktop drag-and-drop overlay ──
await page.evaluate(() => {
  const dt = new DataTransfer();
  dt.items.add(new File(['x'], 'dropped.rpa'));
  window.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt }));
});
await page.locator('[data-drop-overlay]').waitFor({ timeout: 3000 }).catch(() => {});
check('drop overlay appears while dragging files', (await page.locator('[data-drop-overlay]').count()) === 1);
await page.evaluate(() => {
  const dt = new DataTransfer();
  dt.items.add(new File(['x'], 'dropped.rpa'));
  window.dispatchEvent(new DragEvent('dragleave', { dataTransfer: dt }));
});
await page.locator('[data-drop-overlay]').waitFor({ state: 'detached', timeout: 3000 }).catch(() => {});
check('drop overlay hides when the drag leaves', (await page.locator('[data-drop-overlay]').count()) === 0);

check('no console errors', errors.length === 0, errors.join(' | ').slice(0, 400));

await browser.close();
server.close();
console.log(`${passed} passed, ${failures.length} failed`);
for (const f of failures) console.log('  ✗ ' + f);
process.exit(failures.length ? 1 : 0);
