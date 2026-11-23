# RPA Gallery

A mobile-first, 100% client-side PWA for browsing **Ren'Py `.rpa` archives** on a phone.
Open a game's archives and get a gallery of its scenes, grouped by character, with
thumbnails, video/image previews, dialogue, and one-tap saving of individual files.

**Nothing is uploaded.** Archives are read in place with `File.slice()` byte ranges, so even
multi-GB archives never have to fit in memory.

**Live app:** https://red-kenn22.github.io/rpa-gallery/ (open on your phone → Share → *Add to Home Screen*)

## Using it

1. Tap **Open** and select **all** of the game's `.rpa` files at once (scripts and images are
   usually in separate archives). Loose `.rpyc` / `.rpy` files work too.
2. Indexing runs in a background worker; the result is cached in IndexedDB, so reopening the
   same files is instant.
3. Filter by character, search by scene or character name, tap a scene to watch its video,
   swipe through its images, read its dialogue and **Save file**.

## How it works

```
File(s) ──► rpaParser   header + zlib index (RPA-1/2/3/3.2, ALT-1.0), XOR-decoded offsets
        ──► rpyc        RENPY RPC2 / RPC1 containers → zlib → pickle.ts (protocol 0–5)
        ──► astWalker   renpy.ast (Ren'Py 6 → 8.x) → small Stmt model   (rpyParser: .rpy fallback)
        ──► sceneParser characters, image aliases (+ auto images/), labels → scenes, thumbnails
        ──► GalleryIndex (structured-clone safe) → IndexedDB cache → React UI
```

```
src/
├─ lib/
│  ├─ pickle.ts          Python pickle reader, protocols 0–5, never executes anything
│  ├─ rpaParser.ts       archive index + lazy per-file Blobs (entryBlob / readEntry)
│  ├─ rpyc.ts            compiled script container reader
│  ├─ astWalker.ts       pickled AST → Stmt
│  ├─ rpyParser.ts       .rpy source → Stmt (fallback)
│  ├─ pyString.ts        Python literal / call-argument helpers
│  ├─ sceneParser.ts     Stmt → characters, scenes, media
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

`npm test` runs ~270 checks against Python-generated fixtures: every pickle protocol, every
archive format (including a 5 GiB *sparse* archive, ~100 KB on disk), and a fake game with
Ren'Py 8- and Ren'Py 6-style `.rpyc`, a `.rpy` fallback, translations and a corrupt file.

`npm run test:ui` (optional; needs Pillow, ffmpeg and `npx playwright install chromium`)
builds the app and drives it in a phone-sized headless Chromium: indexing, thumbnails
(including video frames), filters, search, the preview sheet, saving, back button,
cache reopen and object-URL cleanup.

## Deploying

Pushing to `main` runs `.github/workflows/deploy.yml`: tests → build → GitHub Pages.
One-time setup: **Settings → Pages → Source: GitHub Actions**.

## Notes

- Some phones can't decode every video codec (e.g. WebM on older iPhones). Those scenes
  fall back to a still thumbnail, and **Save file** still works.
- Not supported: `ZiX-12A/B` obfuscated archives.
