import { useEffect, useRef, useState } from 'react';
import { useInView } from '../hooks/useInView';
import type { CharacterInfo, GalleryIndex, SceneInfo } from '../types';
import { SceneCard } from './SceneCard';

const PAGE = 60;

/** Renders cards in pages of 60 as you scroll, so a 2,000-scene game stays light. */
export function SceneGrid({
  scenes,
  index,
  files,
  characters,
  onOpen,
  onClearFilters,
}: {
  scenes: SceneInfo[];
  index: GalleryIndex;
  files: File[] | null;
  characters: Map<string, CharacterInfo>;
  onOpen: (scene: SceneInfo) => void;
  /** Shown as a "Clear filters" button when a search/character filter hides every scene. */
  onClearFilters?: () => void;
}) {
  const [limit, setLimit] = useState(PAGE);
  const sentinel = useRef<HTMLDivElement>(null);
  const nearEnd = useInView(sentinel, '800px 0px');

  useEffect(() => {
    setLimit(PAGE);
  }, [scenes]);
  useEffect(() => {
    if (nearEnd && limit < scenes.length) setLimit((l) => Math.min(scenes.length, l + PAGE));
  }, [nearEnd, limit, scenes.length]);

  // Floating "back to top" once you're a couple of screens down.
  const [farDown, setFarDown] = useState(false);
  useEffect(() => {
    const onScroll = () => setFarDown(window.scrollY > window.innerHeight * 2);
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  if (!scenes.length) {
    return (
      <div className="flex flex-col items-center gap-3 py-16">
        <p className="text-center text-sm text-neutral-400">No scenes match.</p>
        {onClearFilters && (
          <button type="button" onClick={onClearFilters} className="rounded-full px-4 py-1.5 text-sm text-neutral-200 ring-1 ring-white/20 hover:bg-white/5">
            Clear filters
          </button>
        )}
      </div>
    );
  }

  return (
    <>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {scenes.slice(0, limit).map((s) => (
          <SceneCard key={s.id} scene={s} index={index} files={files} characters={characters} onOpen={onOpen} />
        ))}
      </div>
      <div ref={sentinel} className="h-px" />
      {farDown && (
        <button
          type="button"
          onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
          className="fixed right-[max(1rem,env(safe-area-inset-right))] bottom-[calc(1rem+env(safe-area-inset-bottom))] z-20 rounded-full bg-neutral-800 px-3.5 py-2 text-xs font-medium text-white shadow-lg ring-1 ring-white/15"
          aria-label="Back to top"
        >
          ↑ Top
        </button>
      )}
    </>
  );
}
