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
}: {
  scenes: SceneInfo[];
  index: GalleryIndex;
  files: File[] | null;
  characters: Map<string, CharacterInfo>;
  onOpen: (scene: SceneInfo) => void;
}) {
  const [limit, setLimit] = useState(PAGE);
  const sentinel = useRef<HTMLDivElement>(null);
  const nearEnd = useInView(sentinel, '800px 0px');

  useEffect(() => setLimit(PAGE), [scenes]);
  useEffect(() => {
    if (nearEnd && limit < scenes.length) setLimit((l) => Math.min(scenes.length, l + PAGE));
  }, [nearEnd, limit, scenes.length]);

  if (!scenes.length) {
    return <p className="py-16 text-center text-sm text-neutral-400">No scenes match.</p>;
  }

  return (
    <>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {scenes.slice(0, limit).map((s) => (
          <SceneCard key={s.id} scene={s} index={index} files={files} characters={characters} onOpen={onOpen} />
        ))}
      </div>
      <div ref={sentinel} className="h-px" />
    </>
  );
}
