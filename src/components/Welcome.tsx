import { useEffect, useState } from 'react';
import { clearCache, deleteCachedIndex, listCachedIndexes, type CachedIndexSummary } from '../lib/cache';
import { FilePickerButton } from './FilePickerButton';
import { FolderOpenIcon, TrashIcon } from './Icons';

function ago(ts: number): string {
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

export function Welcome({
  onFiles,
  onOpenCached,
  error,
}: {
  onFiles: (files: File[]) => void;
  onOpenCached: (key: string) => void;
  error?: string;
}) {
  const [recent, setRecent] = useState<CachedIndexSummary[]>([]);
  const refresh = () => void listCachedIndexes().then(setRecent);
  useEffect(refresh, []);

  return (
    <main className="mx-auto max-w-xl px-5 pt-10 pb-16">
      <div className="mb-8 text-center">
        <div className="mx-auto mb-5 grid size-16 place-items-center rounded-2xl bg-gradient-to-br from-rose-500 to-violet-600 text-2xl font-black shadow-lg shadow-rose-500/20">
          R
        </div>
        <h1 className="text-2xl font-bold tracking-tight">Browse Ren'Py scenes</h1>
        <p className="mt-2 text-sm leading-relaxed text-neutral-400">
          Open a game's <code className="text-neutral-200">.rpa</code> archives and get a gallery of its scenes, characters, images and videos.
          Everything stays on this device. Nothing is uploaded.
        </p>
      </div>

      {error && <p className="mb-5 rounded-xl bg-rose-500/10 px-4 py-3 text-sm text-rose-300 ring-1 ring-rose-500/20">{error}</p>}

      <FilePickerButton
        onFiles={onFiles}
        className="flex w-full items-center justify-center gap-2 rounded-2xl bg-white py-4 text-base font-semibold text-neutral-950 active:scale-[0.98]"
      >
        <FolderOpenIcon /> Open archive files
      </FilePickerButton>
      <p className="mt-3 text-center text-xs leading-relaxed text-neutral-500">
        Tip: open the game's <code>game</code> folder and select <b className="text-neutral-300">all</b> its <code>.rpa</code> files <b className="text-neutral-300">and</b> any
        loose <code>.rpyc</code> files. Many games keep their scripts outside the archives.
      </p>

      {recent.length > 0 && (
        <section className="mt-10">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-xs font-semibold tracking-wider text-neutral-500 uppercase">Recently opened</h2>
            <button type="button" className="text-xs text-neutral-500 underline-offset-2 hover:underline" onClick={() => void clearCache().then(refresh)}>
              Clear all
            </button>
          </div>
          <ul className="divide-y divide-white/5 overflow-hidden rounded-2xl bg-white/[0.04] ring-1 ring-white/5">
            {recent.map((r) => (
              <li key={r.key} className="flex items-center gap-2">
                <button type="button" className="min-w-0 flex-1 px-4 py-3 text-left" onClick={() => onOpenCached(r.key)}>
                  <p className="truncate text-sm font-medium">{r.sources.join(', ')}</p>
                  <p className="text-xs text-neutral-500">
                    {r.scenes} scenes · {r.characters} characters · {ago(r.savedAt)}
                  </p>
                </button>
                <button
                  type="button"
                  className="mr-2 grid size-9 place-items-center rounded-full text-neutral-500 hover:bg-white/5"
                  aria-label="Remove from cache"
                  onClick={() => void deleteCachedIndex(r.key).then(refresh)}
                >
                  <TrashIcon width={16} height={16} />
                </button>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-neutral-500">Opening from here shows scenes and dialogue straight away. Select the files again to play media.</p>
        </section>
      )}
    </main>
  );
}
