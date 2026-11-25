import { useState } from 'react';
import { exportDiagnostics } from '../lib/diagnostics';
import type { GalleryIndex, ScenePrograms } from '../types';
import { ShareIcon } from './Icons';

/** Exports a report of how the app read this game (no pictures, sound or dialogue). */
export function DiagnosticsButton({ index, programs, filesAttached }: { index: GalleryIndex; programs: ScenePrograms | null | undefined; filesAttached: boolean }) {
  const [status, setStatus] = useState<'idle' | 'busy' | 'shared' | 'downloaded' | 'error'>('idle');
  const run = async () => {
    setStatus('busy');
    try {
      const r = await exportDiagnostics(index, programs, filesAttached);
      setStatus(r === 'cancelled' ? 'idle' : r);
    } catch {
      setStatus('error');
    }
  };
  const note =
    status === 'downloaded' ? 'Saved to your Downloads folder.'
    : status === 'shared' ? 'Shared.'
    : status === 'error' ? "Couldn't create the report."
    : 'File and label names with counts. No pictures, sound or dialogue.';
  return (
    <div className="mt-6 flex flex-col items-center gap-1.5" data-diagnostics>
      <button
        type="button"
        onClick={run}
        disabled={status === 'busy' || programs === undefined}
        className="flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs text-neutral-300 ring-1 ring-white/15 active:scale-95 disabled:opacity-50"
      >
        <ShareIcon width={14} height={14} /> Export diagnostics
      </button>
      <p className="text-center text-[11px] text-neutral-500" aria-live="polite" data-diagnostics-status={status}>{note}</p>
    </div>
  );
}
