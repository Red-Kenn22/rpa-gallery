import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { CharacterFilterBar, SortBar, type SortMode } from './components/CharacterFilterBar';
import { CharacterHeader } from './components/CharacterHeader';
import { CharacterSelect, MISC_ID } from './components/CharacterSelect';
import { DiagnosticsButton } from './components/DiagnosticsButton';
import { DropOverlay } from './components/DropOverlay';
import { FilePickerButton } from './components/FilePickerButton';
import { Header } from './components/Header';
import { AlertIcon, FolderOpenIcon } from './components/Icons';
import { IndexingProgress } from './components/IndexingProgress';
import { SceneGrid } from './components/SceneGrid';
import { ScenePlayer } from './components/ScenePlayer';
import { ScenePreviewModal } from './components/ScenePreviewModal';
import { MediaNotice, ScriptsNotice } from './components/ScriptsNotice';
import { UpdateToast } from './components/UpdateToast';
import { Welcome } from './components/Welcome';
import { useArchive } from './hooks/useArchive';
import { usePortraits } from './hooks/usePortraits';
import { getHandles, putHandles } from './lib/cache';
import { filesFromHandles, handlesFor } from './lib/fileHandles';
import type { CharacterInfo, GalleryIndex, SceneInfo } from './types';

/** Tiny labels (a line or two, no video): navigation stubs, puzzle steps, resets. */
const isShortScene = (s: SceneInfo) => s.dialogueCount <= 1 && s.videos.length === 0;

/** Games with real characters open on the Characters screen. */
const charactersFirst = (index: GalleryIndex | null) => !!index && index.mode === 'scripts' && index.characters.length >= 2;

function gameTitle(index: GalleryIndex): string {
  const names = index.sources.filter((s) => s.kind === 'rpa').map((s) => s.name);
  return names.length === 1 ? names[0] : names.length ? `${names.length} archives` : index.sources[0]?.name ?? 'Archive';
}

export default function App() {
  const { state, open, openCached, reopen, attachFiles, cancel, close } = useArchive();
  /** Why remembered files couldn't be reopened (shown in the cache banner). */
  const [reopenNote, setReopenNote] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  // Typing stays responsive on big games: filtering uses the deferred value.
  const deferredQuery = useDeferredValue(query);
  const [character, setCharacter] = useState<string | null>(null);
  const [sort, setSort] = useState<SortMode>('story');
  const [showShort, setShowShort] = useState(false);
  const [openScene, setOpenScene] = useState<SceneInfo | null>(null);
  const [playScene, setPlayScene] = useState<SceneInfo | null>(null);
  /** History entries we pushed for open overlays (sheet, player), so Back closes them. */
  const pushed = useRef(0);
  const ignorePop = useRef(0);

  const index = state.status === 'ready' ? state.index : null;
  const files = state.status === 'ready' ? state.files : null;
  const programs = state.status === 'ready' ? state.programs : null;
  const [view, setView] = useState<'characters' | 'scenes'>('characters');
  /** Whether a history entry exists for "inside a character page" (Back returns to Characters). */
  const viewEntry = useRef(false);
  const viewRef = useRef(view);
  viewRef.current = view;
  const { portraitOf, setPortrait, isCustom } = usePortraits(index?.key);

  useEffect(() => {
    setQuery('');
    setCharacter(null);
    setSort('story');
    setShowShort(false);
    setView('characters');
    viewEntry.current = false;
    setOpenScene(null);
    setPlayScene(null);
    // Overlays are gone; forget the history entries we were tracking for them.
    pushed.current = 0;
    ignorePop.current = 0;
  }, [index?.key]);

  const sceneForLabel = useMemo(() => {
    const map = new Map<string, SceneInfo>();
    for (const s of index?.scenes ?? []) for (const l of s.labels) if (!map.has(l)) map.set(l, s);
    return (label: string) => map.get(label);
  }, [index]);

  const characters = useMemo(() => new Map<string, CharacterInfo>((index?.characters ?? []).map((c) => [c.id, c])), [index]);
  /** Speaker variants merged into one character (e.g. "mct" → "mc"). */
  const canonicalId = useMemo(() => {
    const map = new Map<string, string>();
    for (const c of index?.characters ?? []) for (const a of c.aliases ?? []) map.set(a, c.id);
    return (id: string) => map.get(id) ?? id;
  }, [index]);
  const setPortraitFor = useCallback((id: string, path: string | null) => setPortrait(canonicalId(id), path), [setPortrait, canonicalId]);

  const { filtered, shortHidden } = useMemo(() => {
    if (!index) return { filtered: [], shortHidden: 0 };
    const q = deferredQuery.trim().toLowerCase();
    let shortHidden = 0;
    const filtered = index.scenes.filter((s) => {
      if (character === MISC_ID) {
        if (s.characters.length) return false;
      } else if (character && !s.characters.includes(character)) return false;
      if (!q) {
        // Short fragments stay out of the way unless asked for (search always finds them).
        if (!showShort && index.mode === 'scripts' && isShortScene(s)) {
          shortHidden++;
          return false;
        }
        return true;
      }
      if (s.title.toLowerCase().includes(q) || s.id.toLowerCase().includes(q)) return true;
      return s.characters.some((id) => (characters.get(id)?.name ?? id).toLowerCase().includes(q));
    });
    return { filtered, shortHidden };
  }, [index, deferredQuery, character, characters, showShort]);

  const sorted = useMemo(() => {
    if (sort === 'story') return filtered;
    const dir = sort === 'longest' ? -1 : 1;
    return [...filtered].sort((a, b) => dir * (a.durationSec - b.durationSec));
  }, [filtered, sort]);

  // The Android back button / iOS back swipe closes the topmost overlay instead of leaving the app.
  const openSceneRef = useRef(openScene);
  const playSceneRef = useRef(playScene);
  openSceneRef.current = openScene;
  playSceneRef.current = playScene;
  const pushOverlay = () => {
    history.pushState({ overlay: true }, '');
    pushed.current++;
  };
  const popOverlay = () => {
    if (pushed.current > 0) {
      pushed.current--;
      ignorePop.current++; // our own history.back(), not the user's
      history.back();
    }
  };
  const showScene = useCallback((scene: SceneInfo) => {
    if (!openSceneRef.current) pushOverlay(); // already open: just switch scenes
    setOpenScene(scene);
  }, []);
  const hideScene = useCallback(() => {
    setOpenScene(null);
    popOverlay();
  }, []);
  const startPlayer = useCallback((scene: SceneInfo) => {
    if (!playSceneRef.current) pushOverlay();
    setPlayScene(scene);
  }, []);
  const closePlayer = useCallback(() => {
    setPlayScene(null);
    popOverlay();
  }, []);
  // Characters screen → a character's page is a history step too.
  const pickCharacter = useCallback((id: string | null) => {
    setCharacter(id);
    setView('scenes');
    if (!viewEntry.current) {
      viewEntry.current = true;
      pushOverlay();
    }
    window.scrollTo({ top: 0 });
  }, []);
  const backToCharacters = useCallback(() => {
    setView('characters');
    setCharacter(null);
    setQuery('');
    if (viewEntry.current) {
      viewEntry.current = false;
      popOverlay();
    }
  }, []);

  useEffect(() => {
    const onPop = () => {
      if (ignorePop.current > 0) {
        ignorePop.current--;
        return;
      }
      pushed.current = Math.max(0, pushed.current - 1);
      if (playSceneRef.current) setPlayScene(null);
      else if (openSceneRef.current) setOpenScene(null);
      else if (viewEntry.current && viewRef.current === 'scenes') {
        viewEntry.current = false;
        setView('characters');
        setCharacter(null);
      }
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // Files picked through the system picker: remember them for one-tap reopening.
  useEffect(() => {
    if (state.status !== 'ready' || !state.files) return;
    setReopenNote(null);
    const handles = handlesFor(state.files);
    if (handles) void putHandles(state.index.key, handles);
  }, [state]);

  /** Recent list tap: read the remembered files back (Chrome may ask to allow access), else open without them. */
  const openRecent = useCallback(
    async (key: string) => {
      const handles = await getHandles(key);
      if (!handles) return openCached(key);
      const r = await filesFromHandles(handles);
      if ('files' in r) return reopen(key, r.files);
      await openCached(key);
      setReopenNote(
        r.error === 'missing'
          ? `${r.name ?? 'A file'} has moved or been deleted.`
          : r.error === 'denied'
            ? `Access to ${r.name ?? 'the files'} wasn't allowed.`
            : `Couldn't read ${r.name ?? 'the files'} again.`,
      );
    },
    [openCached, reopen],
  );

  const onFiles = useCallback(
    (picked: File[]) => {
      // Picking files for an archive opened from the cache re-attaches them.
      if (state.status === 'ready' && !state.files && attachFiles(picked)) return;
      void open(picked);
    },
    [state, attachFiles, open],
  );

  /** Adds files to the current selection and re-indexes (pickers can't multi-select across folders). */
  const addFiles = useCallback(
    (picked: File[]) => {
      const current = state.status === 'ready' && state.files ? state.files : [];
      const merged = [...current];
      for (const f of picked) {
        if (!merged.some((m) => m.name === f.name && m.size === f.size && m.lastModified === f.lastModified)) merged.push(f);
      }
      void open(merged);
    },
    [state, open],
  );

  // Typing a search on the Characters screen shows matching scenes instead.
  const showCharacters = charactersFirst(index) && view === 'characters' && !deferredQuery.trim();

  const clearFilters = useCallback(() => {
    setQuery('');
    setCharacter(null);
  }, []);
  const filtersActive = !!query.trim() || character !== null;

  const cachedTag = state.status === 'ready' && state.fromCache ? ' · cached' : '';
  const subtitle = !index
    ? undefined
    : index.mode === 'folders'
      ? `${index.scenes.length} folders · ${(index.stats.images + index.stats.videos).toLocaleString()} files${cachedTag}`
      : `${index.scenes.length} scenes · ${index.characters.length} characters${cachedTag}`;

  return (
    <div className="min-h-dvh">
      <Header
        title={index ? gameTitle(index) : 'RPA Gallery'}
        subtitle={subtitle}
        query={query}
        onQuery={setQuery}
        onFiles={onFiles}
        onHome={state.status === 'ready' || state.status === 'error' ? close : undefined}
        showSearch={!!index}
        searchPlaceholder={index?.mode === 'folders' ? 'Search folders' : undefined}
      />

      {state.status === 'idle' && <Welcome onFiles={onFiles} onOpenCached={openRecent} />}
      {state.status === 'error' && <Welcome onFiles={onFiles} onOpenCached={openRecent} error={state.message} />}
      {state.status === 'indexing' && <IndexingProgress progress={state.progress} fileNames={state.fileNames} onCancel={cancel} />}

      {index && (
        <main className="mx-auto max-w-6xl pr-[max(1rem,env(safe-area-inset-right))] pb-[calc(2rem+env(safe-area-inset-bottom))] pl-[max(1rem,env(safe-area-inset-left))]">
          {!files && (
            <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl bg-amber-500/10 px-3 py-2 text-xs leading-relaxed text-amber-200 ring-1 ring-amber-500/20">
              <p className="min-w-0 flex-1" data-reopen-note={reopenNote ?? undefined}>
                {reopenNote ? `${reopenNote} ` : 'Opened from the cache. '}Select the same files to load thumbnails and media.
              </p>
              <FilePickerButton
                onFiles={onFiles}
                label="Select the archive files again"
                className="flex shrink-0 items-center gap-1.5 rounded-full bg-amber-200 px-3 py-1 text-xs font-semibold text-neutral-950 active:scale-95"
              >
                <FolderOpenIcon width={14} height={14} /> Select files
              </FilePickerButton>
            </div>
          )}
          {index.mode === 'folders' && files && <ScriptsNotice index={index} onAddFiles={addFiles} />}
          {index.mode === 'scripts' && files && index.stats.images + index.stats.videos === 0 && <MediaNotice index={index} onAddFiles={addFiles} />}
          {showCharacters ? (
            <CharacterSelect index={index} files={files} characters={index.characters} portraitOf={portraitOf} onPick={pickCharacter} />
          ) : (
          <>
          {charactersFirst(index) && (
            <CharacterHeader
              index={index}
              files={files}
              character={character && character !== MISC_ID ? characters.get(character) ?? null : null}
              label={character === MISC_ID ? 'Misc' : character ? undefined : query.trim() ? 'Search results' : 'All scenes'}
              portrait={character && characters.get(character) ? portraitOf(characters.get(character)!) : undefined}
              isCustom={!!character && isCustom(character)}
              onBack={backToCharacters}
              onSetPortrait={(path) => character && setPortrait(character, path)}
            />
          )}
          {index.characters.length > 0 && (
            <CharacterFilterBar characters={index.characters.filter((c) => c.role !== 'minor' || c.id === character)} selected={character === MISC_ID ? null : character} onSelect={setCharacter} total={index.scenes.length} />
          )}
          {index.scenes.length === 0 ? (
            <p className="py-16 text-center text-sm leading-relaxed text-neutral-400">
              No scenes, images or videos found in these files.{' '}
              {index.stats.scriptsFound === 0 && "Try selecting all of the game's .rpa files, plus any loose .rpyc files from its game folder."}
            </p>
          ) : (
            <>
              {index.mode === 'scripts' ? (
                <SortBar value={sort} onChange={setSort} count={sorted.length} />
              ) : (
                <p className="mb-3 text-xs text-neutral-500">{sorted.length.toLocaleString()} shown</p>
              )}
              <SceneGrid
                scenes={sorted}
                index={index}
                files={files}
                characters={characters}
                onOpen={showScene}
                onClearFilters={filtersActive ? clearFilters : undefined}
              />
              {(shortHidden > 0 || showShort) && (
                <div className="mt-5 flex justify-center">
                  <button
                    type="button"
                    onClick={() => setShowShort((v) => !v)}
                    className="rounded-full px-3.5 py-1.5 text-xs text-neutral-300 ring-1 ring-white/15 active:scale-95"
                    data-show-short
                  >
                    {showShort ? 'Hide short scenes' : `Show ${shortHidden} short scene${shortHidden === 1 ? '' : 's'}`}
                  </button>
                </div>
              )}
            </>
          )}
          </>
          )}

          {index.warnings.length > 0 && (
            <details className="mt-8 rounded-xl bg-white/[0.03] px-4 py-3 text-xs text-neutral-400 ring-1 ring-white/5">
              <summary className="flex cursor-pointer items-center gap-2 font-medium text-neutral-300">
                <AlertIcon width={14} height={14} /> {index.warnings.length} note{index.warnings.length > 1 ? 's' : ''} from indexing
              </summary>
              <ul className="mt-2 list-disc space-y-1 pl-5 break-words">
                {index.warnings.map((w, n) => (
                  <li key={n}>{w}</li>
                ))}
              </ul>
            </details>
          )}
          {files && (
            <div className="mt-6 flex flex-col items-center gap-1.5">
              <FilePickerButton
                onFiles={addFiles}
                label="Add more files to this archive"
                className="rounded-full px-3.5 py-1.5 text-xs text-neutral-300 ring-1 ring-white/15 active:scale-95"
              >
                + Add more files
              </FilePickerButton>
              <p className="max-w-full truncate text-[11px] text-neutral-500" title={index.sources.map((src) => src.name).join(', ')}>
                Loaded: {index.sources.map((src) => src.name).join(', ')}
              </p>
            </div>
          )}
          <DiagnosticsButton index={index} programs={programs} filesAttached={!!files} />
          <p className="mt-3 text-center text-[11px] text-neutral-400">
            {index.stats.scriptsParsed} scripts · {index.stats.archiveEntries.toLocaleString()} archive files · indexed in{' '}
            {index.stats.millis < 1000 ? `${index.stats.millis} ms` : `${(index.stats.millis / 1000).toFixed(1)} s`}
          </p>
        </main>
      )}

      {index && openScene && (
        <ScenePreviewModal
          key={`sheet:${openScene.id}`}
          scene={openScene}
          index={index}
          files={files}
          characters={characters}
          active={!playScene}
          onClose={hideScene}
          onAttachFiles={attachFiles}
          onPlay={() => startPlayer(openScene)}
          playState={
            index.mode !== 'scripts' || programs === null
              ? 'unavailable'
              : programs === undefined
                ? 'loading'
                : !files
                  ? 'needs-files'
                  : 'ready'
          }
        />
      )}

      {index && playScene && programs && files && (
        <ScenePlayer
          key={`player:${playScene.id}`}
          scene={playScene}
          index={index}
          programs={programs}
          files={files}
          sceneForLabel={sceneForLabel}
          onSetPortrait={setPortraitFor}
          onClose={closePlayer}
          onContinue={(next) => {
            setPlayScene(next);
            setOpenScene(next);
          }}
        />
      )}

      <DropOverlay onFiles={onFiles} disabled={!!playScene} />
      <UpdateToast />
    </div>
  );
}
