import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CharacterFilterBar } from './components/CharacterFilterBar';
import { Header } from './components/Header';
import { AlertIcon } from './components/Icons';
import { IndexingProgress } from './components/IndexingProgress';
import { SceneGrid } from './components/SceneGrid';
import { ScenePreviewModal } from './components/ScenePreviewModal';
import { ScriptsNotice } from './components/ScriptsNotice';
import { Welcome } from './components/Welcome';
import { useArchive } from './hooks/useArchive';
import type { CharacterInfo, GalleryIndex, SceneInfo } from './types';

function gameTitle(index: GalleryIndex): string {
  const names = index.sources.filter((s) => s.kind === 'rpa').map((s) => s.name);
  return names.length === 1 ? names[0] : names.length ? `${names.length} archives` : index.sources[0]?.name ?? 'Archive';
}

export default function App() {
  const { state, open, openCached, attachFiles, cancel, close } = useArchive();
  const [query, setQuery] = useState('');
  const [character, setCharacter] = useState<string | null>(null);
  const [openScene, setOpenScene] = useState<SceneInfo | null>(null);
  const pushedHistory = useRef(false);

  const index = state.status === 'ready' ? state.index : null;
  const files = state.status === 'ready' ? state.files : null;

  useEffect(() => {
    setQuery('');
    setCharacter(null);
    setOpenScene(null);
  }, [index?.key]);

  const characters = useMemo(() => new Map<string, CharacterInfo>((index?.characters ?? []).map((c) => [c.id, c])), [index]);

  const filtered = useMemo(() => {
    if (!index) return [];
    const q = query.trim().toLowerCase();
    return index.scenes.filter((s) => {
      if (character && !s.characters.includes(character)) return false;
      if (!q) return true;
      if (s.title.toLowerCase().includes(q) || s.id.toLowerCase().includes(q)) return true;
      return s.characters.some((id) => (characters.get(id)?.name ?? id).toLowerCase().includes(q));
    });
  }, [index, query, character, characters]);

  // The Android back button / iOS back swipe closes the preview instead of leaving the app.
  const showScene = useCallback((scene: SceneInfo) => {
    setOpenScene(scene);
    if (!pushedHistory.current) {
      history.pushState({ scene: scene.id }, '');
      pushedHistory.current = true;
    }
  }, []);
  const hideScene = useCallback(() => {
    if (pushedHistory.current) {
      pushedHistory.current = false;
      history.back();
    }
    setOpenScene(null);
  }, []);
  useEffect(() => {
    const onPop = () => {
      pushedHistory.current = false;
      setOpenScene(null);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const onFiles = useCallback(
    (picked: File[]) => {
      // Picking files for an archive opened from the cache re-attaches them.
      if (state.status === 'ready' && !state.files && attachFiles(picked)) return;
      void open(picked);
    },
    [state, attachFiles, open],
  );

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

      {state.status === 'idle' && <Welcome onFiles={onFiles} onOpenCached={openCached} />}
      {state.status === 'error' && <Welcome onFiles={onFiles} onOpenCached={openCached} error={state.message} />}
      {state.status === 'indexing' && <IndexingProgress progress={state.progress} fileNames={state.fileNames} onCancel={cancel} />}

      {index && (
        <main className="mx-auto max-w-6xl px-4 pb-[calc(2rem+env(safe-area-inset-bottom))]">
          {!files && (
            <p className="mt-3 rounded-xl bg-amber-500/10 px-3 py-2 text-xs leading-relaxed text-amber-200 ring-1 ring-amber-500/20">
              Opened from the cache. Tap <b>Open</b> and select the same files to load thumbnails and media.
            </p>
          )}
          {index.mode === 'folders' && <ScriptsNotice index={index} onFiles={onFiles} />}
          {index.characters.length > 0 && (
            <CharacterFilterBar characters={index.characters} selected={character} onSelect={setCharacter} total={index.scenes.length} />
          )}
          {index.scenes.length === 0 ? (
            <p className="py-16 text-center text-sm leading-relaxed text-neutral-400">
              No scenes, images or videos found in these files.{' '}
              {index.stats.scriptsFound === 0 && "Try selecting all of the game's .rpa files, plus any loose .rpyc files from its game folder."}
            </p>
          ) : (
            <SceneGrid scenes={filtered} index={index} files={files} characters={characters} onOpen={showScene} />
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
          <p className="mt-6 text-center text-[11px] text-neutral-600">
            {index.stats.scriptsParsed} scripts · {index.stats.archiveEntries.toLocaleString()} archive files · indexed in{' '}
            {index.stats.millis < 1000 ? `${index.stats.millis} ms` : `${(index.stats.millis / 1000).toFixed(1)} s`}
          </p>
        </main>
      )}

      {index && openScene && (
        <ScenePreviewModal
          key={openScene.id}
          scene={openScene}
          index={index}
          files={files}
          characters={characters}
          onClose={hideScene}
          onAttachFiles={attachFiles}
        />
      )}
    </div>
  );
}
