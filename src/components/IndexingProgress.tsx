import type { IndexProgress } from '../types';

const LABELS: Record<IndexProgress['phase'], string> = {
  'reading-index': 'Reading archive index',
  'parsing-scripts': 'Decompiling scripts',
  building: 'Building scenes',
};

export function IndexingProgress({
  progress,
  fileNames,
  onCancel,
}: {
  progress: IndexProgress | null;
  fileNames: string[];
  onCancel: () => void;
}) {
  const pct = progress && progress.total ? Math.round((progress.done / progress.total) * 100) : 0;
  return (
    <main className="mx-auto flex max-w-md flex-col items-center px-6 pt-24 text-center">
      <div className="mb-6 size-10 animate-spin rounded-full border-[3px] border-white/10 border-t-rose-400" />
      <h2 className="text-lg font-semibold">{progress ? LABELS[progress.phase] : 'Starting…'}</h2>
      <p className="mt-1 h-5 w-full truncate text-sm text-neutral-400">{progress?.current ?? fileNames.join(', ')}</p>
      <div className="mt-5 h-1.5 w-full overflow-hidden rounded-full bg-white/10" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
        <div className="h-full rounded-full bg-gradient-to-r from-rose-500 to-violet-500 transition-[width] duration-200" style={{ width: `${pct}%` }} />
      </div>
      <p className="mt-2 text-xs text-neutral-500">
        {progress ? `${progress.done} / ${progress.total}` : ''}
      </p>
      <button type="button" onClick={onCancel} className="mt-8 rounded-full px-5 py-2 text-sm text-neutral-300 ring-1 ring-white/15 active:scale-95">
        Cancel
      </button>
    </main>
  );
}
