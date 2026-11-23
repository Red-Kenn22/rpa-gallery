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
});
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

const files = [join(fixtures, 'scripts.rpa'), join(fixtures, 'images.rpa')];
const cards = page.locator('[data-scene]');

// ── Welcome ──
await page.goto(url);
await page.getByText("Browse Ren'Py scenes").waitFor();
await page.screenshot({ path: join(shots, '1-welcome.png') });
check('welcome renders', true);

// ── Open both archives → index in worker → grid ──
const t0 = Date.now();
await page.locator('input[type=file]').first().setInputFiles(files);
await cards.first().waitFor({ timeout: 20000 });
check('indexed in worker', (await cards.count()) === 6, `cards=${await cards.count()}`);
check('subtitle', /6 scenes · 6 characters/.test(await page.locator('header').innerText()));
console.log(`  indexing + first paint: ${Date.now() - t0} ms`);

// Thumbnails: every card has media in this fixture (3 come from video frames).
await page.waitForFunction(() => {
  const imgs = [...document.querySelectorAll('[data-scene] img')];
  return imgs.length === 6 && imgs.every((i) => i.complete && i.naturalWidth > 0);
}, null, { timeout: 30000 }).catch(() => {});
const thumbCount = await page.locator('[data-scene] img').count();
check('all thumbnails generated', thumbCount === 6, `thumbs=${thumbCount}`);
const startThumb = await page.locator('[data-scene="start"] img').getAttribute('src');
check('video thumbnail is a JPEG frame', startThumb?.startsWith('data:image/jpeg') ?? false);
check('badges', (await page.locator('[data-scene="start"]').innerText()).includes('VIDEO') && (await page.locator('[data-scene="chapter_two"]').innerText()).includes('1 IMAGE'));
await page.screenshot({ path: join(shots, '2-grid.png') });

// ── Character filter ──
await page.getByRole('button', { name: /^Lucy\b/ }).first().click();
check('filter by Lucy', (await cards.count()) === 1 && (await cards.first().getAttribute('data-scene')) === 'beach', `cards=${await cards.count()}`);
await page.screenshot({ path: join(shots, '3-filter.png') });
await page.getByRole('button', { name: /^All\b/ }).click();
check('filter cleared', (await cards.count()) === 6);

// ── Search ──
await page.getByPlaceholder('Search scenes or characters').fill('jun');
check('search by character name', (await cards.count()) === 1 && (await cards.first().getAttribute('data-scene')) === 'chapter_two');
await page.getByPlaceholder('Search scenes or characters').fill('beach');
check('search by title', (await cards.count()) === 2, `cards=${await cards.count()}`);
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
check('back button closes preview', (await page.getByRole('dialog').count()) === 0 && (await cards.count()) === 6);
await page.waitForTimeout(300);
const live = await page.evaluate(() => window.__liveUrls());
check('all object URLs revoked', live === 0, `live=${live}`);

// ── Reopen same files: instant from IndexedDB, thumbnails cached ──
await page.reload();
await page.getByText('Recently opened').waitFor();
await page.screenshot({ path: join(shots, '6-welcome-recent.png') });
const t1 = Date.now();
await page.locator('input[type=file]').first().setInputFiles(files);
await cards.first().waitFor();
check('reopen uses cache', (await page.locator('header').innerText()).includes('cached'));
console.log(`  cached reopen: ${Date.now() - t1} ms`);

// ── Open from the recent list without files: dialogue + cached thumbs ──
await page.getByLabel('Home').click();
await page.getByText('Recently opened').waitFor();
await page.locator('main li button').first().click();
await cards.first().waitFor();
check('cache-only banner', (await page.getByText('Opened from the cache').count()) === 1);
await page.waitForFunction(() => document.querySelectorAll('[data-scene] img').length === 6, null, { timeout: 10000 }).catch(() => {});
check('thumbnails from IndexedDB without files', (await page.locator('[data-scene] img').count()) === 6);
await page.locator('[data-scene="start"]').click();
check('preview asks for files', (await page.getByRole('dialog').innerText()).includes('Select files'));
await page.screenshot({ path: join(shots, '7-cache-only.png') });

check('no console errors', errors.length === 0, errors.join(' | ').slice(0, 400));

await browser.close();
server.close();
console.log(`${passed} passed, ${failures.length} failed`);
for (const f of failures) console.log('  ✗ ' + f);
process.exit(failures.length ? 1 : 0);
