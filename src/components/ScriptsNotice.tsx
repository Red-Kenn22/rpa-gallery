import type { GalleryIndex } from '../types';
import { FilePickerButton } from './FilePickerButton';
import { FolderOpenIcon } from './Icons';

/** Explains folder mode: what was found, and what to select to get real scenes. */
export function ScriptsNotice({ index, onAddFiles }: { index: GalleryIndex; onAddFiles: (files: File[]) => void }) {
  const { stats } = index;
  const archives = index.sources.filter((s) => s.kind === 'rpa').map((s) => s.name);
  const where = archives.length === 1 ? archives[0] : archives.length ? 'these archives' : 'these files';
  const n = (count: number, one: string, many: string) => `${count.toLocaleString()} ${count === 1 ? one : many}`;
  const found = [
    n(stats.images, 'image', 'images'),
    n(stats.videos, 'video', 'videos'),
    stats.audio ? n(stats.audio, 'audio file', 'audio files') : '',
  ].filter(Boolean).join(' · ');

  const unreadable = stats.scriptsFound > 0;
  return (
    <div className="mt-3 rounded-2xl bg-sky-500/10 px-4 py-3.5 text-sm leading-relaxed text-sky-100 ring-1 ring-sky-400/20">
      <p className="font-semibold">{unreadable ? 'Scripts found, but no scenes could be read' : `No game scripts in ${where}`}</p>
      <p className="mt-1 text-sky-100/80">
        Found {found}.{' '}
        {unreadable ? (
          <>The game's scripts couldn't be turned into scenes (see the notes at the bottom).</>
        ) : (
          <>
            The scripts are probably in the game's Android <code className="text-white">.apk</code>, or loose{' '}
            <code className="text-white">.rpyc</code> files in its <code className="text-white">game</code> folder. Add them (they can be in a
            different folder) to get scenes, characters and dialogue.
          </>
        )}
      </p>
      <p className="mt-1 text-sky-100/60">Showing the files by folder for now.</p>
      {!unreadable && (
        <FilePickerButton
          onFiles={onAddFiles}
          label="Add the APK or script files"
          className="mt-3 flex items-center gap-1.5 rounded-full bg-white px-3.5 py-2 text-sm font-semibold text-neutral-950 active:scale-95"
        >
          <FolderOpenIcon width={16} height={16} /> Add APK or scripts
        </FilePickerButton>
      )}
    </div>
  );
}

/** Scripts found but no media (e.g. only the APK was opened): ask for the archive. */
export function MediaNotice({ index, onAddFiles }: { index: GalleryIndex; onAddFiles: (files: File[]) => void }) {
  return (
    <div className="mt-3 rounded-2xl bg-sky-500/10 px-4 py-3.5 text-sm leading-relaxed text-sky-100 ring-1 ring-sky-400/20">
      <p className="font-semibold">No images or videos found</p>
      <p className="mt-1 text-sky-100/80">
        Found {index.stats.scriptsParsed} scripts, but the game's media is in another file. Add its{' '}
        <code className="text-white">.rpa</code> archive(s) (on Android usually <code className="text-white">archive.rpa</code> in{' '}
        <code className="text-white">Documents/renpy_saves/…/game</code>).
      </p>
      <FilePickerButton
        onFiles={onAddFiles}
        label="Add the game's archive files"
        className="mt-3 flex items-center gap-1.5 rounded-full bg-white px-3.5 py-2 text-sm font-semibold text-neutral-950 active:scale-95"
      >
        <FolderOpenIcon width={16} height={16} /> Add archive
      </FilePickerButton>
    </div>
  );
}
