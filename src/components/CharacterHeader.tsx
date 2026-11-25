import { useMemo, useState } from 'react';
import { useAssetThumbnail } from '../hooks/useAssetThumbnail';
import { formatDuration, normalizeHex } from '../lib/format';
import type { CharacterInfo, GalleryIndex } from '../types';
import { ChevronLeftIcon, ImageIcon, XIcon } from './Icons';

function Thumb({ index, files, path, className }: { index: GalleryIndex; files: File[] | null; path?: string; className: string }) {
  const src = useAssetThumbnail(index, path, files, true, 320, 'portrait');
  return src ? (
    <img src={src} alt="" className={`${className} object-cover object-top`} draggable={false} />
  ) : (
    <div className={`${className} grid place-items-center bg-neutral-800 text-neutral-600`}>
      <ImageIcon width={18} height={18} />
    </div>
  );
}

/** Top of a character's page: portrait, name, totals, back to Characters, change portrait. */
export function CharacterHeader({
  index,
  files,
  character,
  label,
  portrait,
  isCustom,
  onBack,
  onSetPortrait,
}: {
  index: GalleryIndex;
  files: File[] | null;
  character: CharacterInfo | null;
  /** Title when not a character page ("All scenes", "Misc"). */
  label?: string;
  portrait?: string;
  isCustom: boolean;
  onBack: () => void;
  onSetPortrait: (path: string | null) => void;
}) {
  const [picking, setPicking] = useState(false);
  const scenes = useMemo(() => (character ? index.scenes.filter((s) => s.characters.includes(character.id)) : []), [index, character]);
  const secs = scenes.reduce((n, s) => n + s.durationSec, 0);
  // Picker choices: the automatic candidates, then images from this character's scenes.
  const choices = useMemo(() => {
    const out = [...(character?.portraitCandidates ?? [])];
    for (const s of scenes) for (const img of s.images) if (!out.includes(img) && out.length < 36) out.push(img);
    return out;
  }, [character, scenes]);
  const accent = normalizeHex(character?.color) ?? '#fda4af';

  return (
    <div className="pt-3" data-character-header>
      <button type="button" onClick={onBack} className="-ml-1 flex items-center gap-1 rounded-full px-1 py-1 text-sm text-neutral-300 hover:text-white" aria-label="Back to characters">
        <ChevronLeftIcon width={16} height={16} /> Characters
      </button>
      {!character && label && <h2 className="mt-2 text-xl font-bold">{label}</h2>}
      {character && (
        <div className="mt-2 flex items-center gap-3">
          <Thumb index={index} files={files} path={portrait} className="h-20 w-16 shrink-0 rounded-xl ring-1 ring-white/10" />
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-xl font-bold" style={{ color: accent }}>
              {character.name}
            </h2>
            <p className="text-xs text-neutral-400">
              {scenes.length} scene{scenes.length === 1 ? '' : 's'} · {formatDuration(secs)} · {character.lineCount.toLocaleString()} lines
            </p>
          </div>
          {files && choices.length > 0 && (
            <button type="button" onClick={() => setPicking(true)} className="shrink-0 rounded-full px-3 py-1.5 text-xs text-neutral-200 ring-1 ring-white/15 hover:bg-white/5">
              Change portrait
            </button>
          )}
        </div>
      )}

      {picking && character && (
        <div className="fixed inset-0 z-50 flex flex-col justify-end" role="dialog" aria-modal="true" aria-label={`Portrait for ${character.name}`} data-portrait-picker>
          <button type="button" className="absolute inset-0 bg-black/75" onClick={() => setPicking(false)} aria-label="Close" />
          <div className="relative mx-auto max-h-[85dvh] w-full max-w-3xl overflow-y-auto rounded-t-3xl bg-neutral-900 px-4 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))] ring-1 ring-white/10 sm:mb-6 sm:rounded-3xl">
            <div className="mb-3 flex items-center gap-2">
              <p className="flex-1 text-sm font-semibold">Choose a portrait for {character.name}</p>
              {isCustom && (
                <button
                  type="button"
                  onClick={() => {
                    onSetPortrait(null);
                    setPicking(false);
                  }}
                  className="rounded-full px-3 py-1 text-xs text-neutral-300 ring-1 ring-white/15"
                >
                  Reset to automatic
                </button>
              )}
              <button type="button" onClick={() => setPicking(false)} className="grid size-8 place-items-center rounded-full bg-white/10" aria-label="Close portrait picker">
                <XIcon width={15} height={15} />
              </button>
            </div>
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
              {choices.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => {
                    onSetPortrait(p);
                    setPicking(false);
                  }}
                  className={`overflow-hidden rounded-xl ring-2 ${p === portrait ? 'ring-rose-400' : 'ring-transparent'}`}
                  aria-label={`Use ${p.slice(p.lastIndexOf('/') + 1)}`}
                  data-portrait-choice
                >
                  <Thumb index={index} files={files} path={p} className="aspect-[3/4] w-full" />
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
