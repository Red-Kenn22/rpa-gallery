import type { GalleryIndex } from '../types';
import { FilePickerButton } from './FilePickerButton';
import { FolderOpenIcon } from './Icons';

/** Explains folder mode: what was found, and what to select to get real scenes. */
export function ScriptsNotice({ index, onFiles }: { index: GalleryIndex; onFiles: (files: File[]) => void }) {
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
            This game probably keeps its scripts as loose <code className="text-white">.rpyc</code> files in its{' '}
            <code className="text-white">game</code> folder. Select them <b>together with</b> {archives.length ? archives.join(', ') : 'the archives'} to get
            scenes, characters and dialogue.
          </>
        )}
      </p>
      <p className="mt-1 text-sky-100/60">Showing the files by folder for now.</p>
      {!unreadable && (
        <FilePickerButton
          onFiles={onFiles}
          className="mt-3 flex items-center gap-1.5 rounded-full bg-white px-3.5 py-2 text-sm font-semibold text-neutral-950 active:scale-95"
        >
          <FolderOpenIcon width={16} height={16} /> Select archives + scripts
        </FilePickerButton>
      )}
    </div>
  );
}
