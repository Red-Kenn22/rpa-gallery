import { useEffect, useState } from 'react';
import { onUpdateReady } from '../lib/swUpdate';
import { XIcon } from './Icons';

/** Non-blocking "update available" prompt; nothing reloads until the user taps Reload. */
export function UpdateToast() {
  const [apply, setApply] = useState<(() => void) | null>(null);
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => onUpdateReady((fn) => setApply(() => fn)), []);
  if (!apply || dismissed) return null;
  return (
    <div className="fixed inset-x-0 bottom-[max(1rem,env(safe-area-inset-bottom))] z-[90] flex justify-center px-4" role="status">
      <div className="flex items-center gap-3 rounded-full bg-neutral-800 py-1.5 pr-1.5 pl-4 text-sm shadow-lg ring-1 ring-white/10">
        <span>Update available</span>
        <button type="button" onClick={apply} className="rounded-full bg-white px-3 py-1 text-xs font-semibold text-neutral-950">
          Reload
        </button>
        <button type="button" onClick={() => setDismissed(true)} className="grid size-7 place-items-center rounded-full text-neutral-400" aria-label="Dismiss update notice">
          <XIcon width={14} height={14} />
        </button>
      </div>
    </div>
  );
}
