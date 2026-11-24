import { memo, useRef } from 'react';
import { useInView } from '../hooks/useInView';
import { useThumbnail } from '../hooks/useThumbnail';
import { formatDuration, tagColors } from '../lib/format';
import type { CharacterInfo, GalleryIndex, SceneInfo } from '../types';
import { ChatIcon, ClockIcon, ImageIcon, PlayIcon } from './Icons';

export function mediaBadge(scene: SceneInfo): { label: string; kind: 'video' | 'image' | 'text' } {
  if (scene.videos.length) return { label: scene.videos.length > 1 ? `${scene.videos.length} VIDEOS` : 'VIDEO', kind: 'video' };
  if (scene.images.length) return { label: `${scene.images.length} IMAGE${scene.images.length > 1 ? 'S' : ''}`, kind: 'image' };
  return { label: 'TEXT', kind: 'text' };
}

function SceneCardImpl({
  scene,
  index,
  files,
  characters,
  onOpen,
}: {
  scene: SceneInfo;
  index: GalleryIndex;
  files: File[] | null;
  characters: Map<string, CharacterInfo>;
  onOpen: (scene: SceneInfo) => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const inView = useInView(ref);
  const thumb = useThumbnail(index, scene, files, inView);
  const badge = mediaBadge(scene);
  // In folder mode the tag is the top-level folder; skip it when it just repeats the title.
  const shown = scene.characters.filter((id) => characters.get(id)?.name !== scene.title).slice(0, 3);
  const more = index.mode === 'folders' ? 0 : scene.characters.length - shown.length;

  return (
    <button
      ref={ref}
      type="button"
      onClick={() => onOpen(scene)}
      className="group flex flex-col overflow-hidden rounded-2xl bg-white/[0.04] text-left ring-1 ring-white/[0.06] transition active:scale-[0.98] [content-visibility:auto] [contain-intrinsic-size:auto_240px]"
      data-scene={scene.id}
    >
      <div className="relative aspect-[16/10] w-full overflow-hidden bg-neutral-900">
        {thumb.src ? (
          <img src={thumb.src} alt="" className="size-full object-cover" draggable={false} />
        ) : (
          <div className="grid size-full place-items-center bg-gradient-to-br from-neutral-800 to-neutral-900 text-neutral-600">
            {thumb.status === 'loading' ? (
              <span className="size-5 animate-spin rounded-full border-2 border-neutral-600 border-t-transparent" />
            ) : badge.kind === 'video' ? (
              <PlayIcon width={26} height={26} />
            ) : badge.kind === 'image' ? (
              <ImageIcon width={26} height={26} />
            ) : (
              <ChatIcon width={26} height={26} />
            )}
          </div>
        )}
        <span
          className={`absolute top-2 left-2 flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-bold tracking-wide backdrop-blur ${
            badge.kind === 'video' ? 'bg-rose-500/90 text-white' : 'bg-black/60 text-white'
          }`}
        >
          {badge.kind === 'video' && <PlayIcon width={9} height={9} />}
          {badge.label}
        </span>
        {scene.durationSec > 0 && (
          <span className="absolute right-2 bottom-2 flex items-center gap-1 rounded-md bg-black/60 px-1.5 py-0.5 text-[10px] font-medium text-neutral-200 backdrop-blur">
            <ClockIcon width={10} height={10} />
            {formatDuration(scene.durationSec)}
          </span>
        )}
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-1.5 p-2.5">
        <h3 className="line-clamp-2 text-[13px] leading-snug font-semibold">{scene.title}</h3>
        {shown.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {shown.map((id) => {
              const c = characters.get(id);
              return (
                <span
                  key={id}
                  className="max-w-full truncate rounded px-1.5 py-0.5 text-[10px] font-medium"
                  style={tagColors(c?.color)}
                >
                  {c?.name ?? id}
                </span>
              );
            })}
            {more > 0 && <span className="rounded bg-white/5 px-1.5 py-0.5 text-[10px] text-neutral-400">+{more}</span>}
          </div>
        )}
      </div>
    </button>
  );
}

export const SceneCard = memo(SceneCardImpl);
