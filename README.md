# RPA Gallery

A mobile-first, 100% client-side PWA for browsing **Ren'Py `.rpa` archives** on a phone.
Open a game's archives and get a gallery of its scenes, grouped by character, with
thumbnails, video/image previews, dialogue, and one-tap saving of individual files.

**Nothing is uploaded.** Archives are read in place with `File.slice()` byte ranges, so even
multi-GB archives never have to fit in memory.

**Live app:** https://red-kenn22.github.io/rpa-gallery/ (open on your phone → Share → *Add to Home Screen*)

## Using it

1. Tap **Open** and select the game's files together:
   - **PC/Mac download:** all `.rpa` files in the `game` folder, plus any loose `.rpyc` files.
   - **Android:** the game's **`.apk`** plus its `archive.rpa` (scripts live inside the APK,
     media in the archive). The APK is read in place, never unpacked.
   If no scripts are selected, the archive's images and videos are browsable by folder.
2. Indexing runs in a background worker; the result is cached in IndexedDB, so reopening the
   same files is instant.
3. Filter by character, search, and sort by **story order / longest / shortest** (estimated
   play time). Split labels are merged into whole scenes (menu branches, the labels they
   rejoin at, `_part2`-style continuations and local labels).
4. Tap a scene to preview its media and dialogue, or **Play scene** to tap through it like the
   game: full-screen images and videos placed on the game's stage, sprites at their
   positions, speaker names, menus as buttons, `if` branches you pick (or auto-pick),
   Back one line, save any frame, and **Continue** into the next scene.

The player is "level 1": it doesn't run the game's Python, play music or render custom
screens (phone chat UIs and similar).

## How it works

```
File(s) ──► rpaParser   header + zlib index (RPA-1/2/3/3.2, ALT-1.0), XOR-decoded offsets
        ──► zipReader   APK central directory; assets/x-game/x-… → game paths
        ──► rpyc        RENPY RPC2 / RPC1 containers → zlib → pickle.ts (protocol 0–5)
        ──► astWalker   renpy.ast (Ren'Py 6 → 8.x) → small Stmt model   (rpyParser: .rpy fallback)
        ──► sceneParser characters, image aliases, label graph → merged scenes, time estimates
        ──► program     labels → player steps (menus/ifs → gotos)  → playerEngine → ScenePlayer
        ──► GalleryIndex + ScenePrograms → IndexedDB cache → React UI
```

```
src/
├─ lib/
│  ├─ pickle.ts          Python pickle reader, protocols 0–5, never executes anything
│  ├─ rpaParser.ts       archive index + lazy per-file Blobs (entryBlob / readEntry)
│  ├─ zipReader.ts       APK/ZIP directory, stored + deflated entries, ZIP64
│  ├─ rpyc.ts            compiled script container reader
│  ├─ astWalker.ts       pickled AST → Stmt
│  ├─ rpyParser.ts       .rpy source → Stmt (fallback)
│  ├─ pyString.ts        Python literal / call-argument helpers
│  ├─ sceneParser.ts     Stmt → characters, merged scenes, media, durations
│  ├─ program.ts         label → player steps
│  ├─ playerEngine.ts    runs steps to the next tap/choice; exact Back
│  ├─ indexer.ts         the whole pipeline (worker-agnostic, testable in Node)
│  ├─ archiveClient.ts   UI-side worker wrapper + assetBlob()
│  ├─ cache.ts           IndexedDB: indexes + thumbnail data URLs
│  └─ thumbnailer.ts     image/video frame grabs, decode queue, URL revocation
├─ workers/              archive.worker.ts + typed protocol
├─ hooks/                useArchive, useThumbnail, useInView (shared IntersectionObserver)
└─ components/           Header, CharacterFilterBar, SceneGrid, SceneCard, ScenePreviewModal, …
```

## Development

```bash
npm install
npm run dev          # http://localhost:5173 (also on your LAN for phone testing)
npm test             # parser + pipeline tests (needs python3)
npm run build
```

`npm test` runs ~330 checks against Python-generated fixtures: every pickle protocol, every
archive format (including a 5 GiB *sparse* archive, ~100 KB on disk), and a fake game with
Ren'Py 8- and Ren'Py 6-style `.rpyc`, a `.rpy` fallback, translations, a corrupt file, split
scenes (branches, rejoins, continuations) and an Android APK, plus the player engine.

`npm run test:ui` (optional; needs Pillow, ffmpeg and `npx playwright install chromium`)
builds the app and drives it in a phone-sized headless Chromium: indexing, thumbnails
(including video frames), filters, search, sorting, the preview sheet, saving, the APK flow,
the scene player (menus, image-only beats, Back, Continue, looping Movie backgrounds), the
back button, cache reopen and object-URL cleanup.

## Deploying

Pushing to `main` runs `.github/workflows/deploy.yml`: tests → build → GitHub Pages.
One-time setup: **Settings → Pages → Source: GitHub Actions**.

## Notes

- Some phones can't decode every video codec (e.g. WebM on older iPhones). Those scenes
  fall back to a still thumbnail, and **Save file** still works.
- Not supported: `ZiX-12A/B` obfuscated archives.
