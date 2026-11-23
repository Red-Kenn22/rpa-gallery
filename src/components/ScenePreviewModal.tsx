import { useEffect, useMemo, useRef, useState } from 'react';
import { assetBlob } from '../lib/archiveClient';
import { formatBytes, tagColors } from '../lib/format';
import type { AssetRef, CharacterInfo, GalleryIndex, SceneInfo } from '../types';
import { FilePickerButton } from './FilePickerButton';
import { ChevronLeftIcon, ChevronRightIcon, DownloadIcon, FolderOpenIcon, ShareIcon, XIcon } from './Icons';

const baseName = (p: string) => p.slice(p.lastIndexOf('/') + 1);

function download(url: string, name: string) {
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export function ScenePreviewModal({
  scene,
  index,
  files,
  characters,
  onClose,
  onAttachFiles,
}: {
  scene: SceneInfo;
  index: GalleryIndex;
  files: File[] | null;
  characters: Map<string, CharacterInfo>;
  onClose: () => void;
  onAttachFiles: (files: File[]) => boolean;
}) {
  const items = useMemo<AssetRef[]>(
    () => [...scene.videos, ...scene.images].map((p) => index.assets[p]).filter((a): a is AssetRef => !!a),
    [scene, index],
  );
  const [i, setI] = useState(0);
  const [media, setMedia] = useState<{ path: string; url: string } | null>(null);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const [attachError, setAttachError] = useState(false);
  const touchX = useRef<number | null>(null);
  const item = items[i];

  // One object URL at a time. The media element only renders while its URL
  // belongs to the current item, so it is already unmounted when the
  // cleanup revokes the URL (no requests to dead blob: URLs).
  useEffect(() => {
    setMediaError(null);
    if (!item || !files) return;
    let u: string | null = null;
    try {
      u = URL.createObjectURL(assetBlob(files, item));
      setMedia({ path: item.path, url: u });
    } catch (e) {
      setMediaError((e as Error).message);
    }
    return () => {
      if (u) URL.revokeObjectURL(u);
    };
  }, [item, files]);
  const url = media && item && media.path === item.path ? media.url : null;

  const go = (d: number) => setI((n) => Math.min(items.length - 1, Math.max(0, n + d)));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowRight') setI((n) => Math.min(items.length - 1, n + 1));
      else if (e.key === 'ArrowLeft') setI((n) => Math.max(0, n - 1));
    };
    window.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose, items.length]);

  const canShare = typeof navigator !== 'undefined' && typeof navigator.canShare === 'function';

  const share = async () => {
    if (!files || !item) return;
    const file = new File([assetBlob(files, item)], baseName(item.path), { type: item.mime });
    try {
      if (navigator.canShare?.({ files: [file] })) await navigator.share({ files: [file], title: scene.title });
      else if (url) download(url, baseName(item.path));
    } catch {
      /* user dismissed the share sheet */
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end" role="dialog" aria-modal="true" aria-label={scene.title}>
      <button type="button" className="absolute inset-0 bg-black/75 backdrop-blur-sm" onClick={onClose} aria-label="Close" />
      <div className="relative mx-auto flex max-h-[94dvh] w-full max-w-3xl animate-[sheet-in_220ms_ease-out] flex-col overflow-hidden rounded-t-3xl bg-neutral-900 pb-[env(safe-area-inset-bottom)] ring-1 ring-white/10 sm:mb-6 sm:rounded-3xl">
        <div className="mx-auto mt-2 h-1 w-10 rounded-full bg-white/20" />
        <div className="flex items-start gap-3 px-4 pt-2 pb-3">
          <div className="min-w-0 flex-1">
            <h2 className="text-base leading-tight font-semibold">{scene.title}</h2>
            <p className="mt-0.5 truncate text-xs text-neutral-400">
              {index.mode === 'folders' ? scene.file : `${scene.id} · ${scene.file}:${scene.line}`}
            </p>
          </div>
          <button type="button" onClick={onClose} className="grid size-8 shrink-0 place-items-center rounded-full bg-white/10" aria-label="Close">
            <XIcon width={16} height={16} />
          </button>
        </div>

        {items.length > 0 && (
          <div className="shrink-0">
            <div
              className="relative grid aspect-video w-full place-items-center bg-black"
              onTouchStart={(e) => (touchX.current = e.touches[0].clientX)}
              onTouchEnd={(e) => {
                if (touchX.current === null) return;
                const dx = e.changedTouches[0].clientX - touchX.current;
                touchX.current = null;
                if (Math.abs(dx) > 50 && item?.kind !== 'video') go(dx < 0 ? 1 : -1);
              }}
            >
              {!files ? (
                <div className="flex flex-col items-center gap-3 px-6 text-center">
                  <p className="text-sm text-neutral-300">This scene was opened from the cache. Select the same archive files again to play its media.</p>
                  <FilePickerButton
                    onFiles={(f) => setAttachError(!onAttachFiles(f))}
                    className="flex items-center gap-1.5 rounded-full bg-white px-4 py-2 text-sm font-semibold text-neutral-950"
                  >
                    <FolderOpenIcon width={16} height={16} /> Select files
                  </FilePickerButton>
                  {attachError && <p className="text-xs text-rose-400">Those files don't match this archive.</p>}
                </div>
              ) : mediaError ? (
                <p className="px-6 text-center text-sm text-neutral-300">{mediaError}</p>
              ) : url && item?.kind === 'video' ? (
                <video
                  key={url}
                  src={url}
                  controls
                  playsInline
                  preload="metadata"
                  className="size-full"
                  onError={() => setMediaError("This video can't play on this device. Use Save to open it in another app.")}
                />
              ) : url ? (
                <img key={url} src={url} alt={baseName(item!.path)} className="size-full object-contain" draggable={false} />
              ) : null}

              {items.length > 1 && (
                <>
                  <button type="button" onClick={() => go(-1)} disabled={i === 0} className="absolute top-1/2 left-2 grid size-9 -translate-y-1/2 place-items-center rounded-full bg-black/50 disabled:opacity-0" aria-label="Previous">
                    <ChevronLeftIcon />
                  </button>
                  <button type="button" onClick={() => go(1)} disabled={i === items.length - 1} className="absolute top-1/2 right-2 grid size-9 -translate-y-1/2 place-items-center rounded-full bg-black/50 disabled:opacity-0" aria-label="Next">
                    <ChevronRightIcon />
                  </button>
                </>
              )}
            </div>

            <div className="flex items-center gap-2 px-4 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-medium text-neutral-200">{item && baseName(item.path)}</p>
                <p className="text-[11px] text-neutral-500">
                  {i + 1} / {items.length} · {item?.kind === 'video' ? 'Video' : 'Image'} · {item ? formatBytes(item.length) : ''}
                </p>
              </div>
              {files && url && canShare && (
                <button type="button" onClick={share} className="grid size-9 place-items-center rounded-full bg-white/10" aria-label="Share">
                  <ShareIcon width={17} height={17} />
                </button>
              )}
              {files && url && (
                <button type="button" onClick={() => item && download(url, baseName(item.path))} className="flex items-center gap-1.5 rounded-full bg-white px-3.5 py-2 text-sm font-semibold text-neutral-950 active:scale-95">
                  <DownloadIcon width={16} height={16} /> Save file
                </button>
              )}
            </div>
          </div>
        )}

        {index.mode === 'folders' ? (
          <p className="border-t border-white/5 px-4 py-3 text-xs text-neutral-500">
            Folder view: {scene.images.length} images, {scene.videos.length} videos. Swipe or use the arrows to browse.
          </p>
        ) : (
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain border-t border-white/5 px-4 py-3">
          <h3 className="mb-2 text-xs font-semibold tracking-wider text-neutral-500 uppercase">
            Dialogue · {scene.dialogueCount}
          </h3>
          {scene.dialogue.length === 0 ? (
            <p className="text-sm text-neutral-500">No dialogue in this scene.</p>
          ) : (
            <ol className="space-y-2.5">
              {scene.dialogue.map((d, n) => {
                const c = d.who ? characters.get(d.who) : undefined;
                if (d.choice) {
                  return (
                    <li key={n} className="rounded-lg border border-dashed border-white/15 px-3 py-1.5 text-sm text-neutral-300">
                      ▸ {d.what}
                    </li>
                  );
                }
                return (
                  <li key={n} className="text-[15px] leading-relaxed">
                    {d.who ? (
                      <span className="mr-1.5 text-xs font-semibold" style={{ color: tagColors(c?.color).color }}>
                        {c?.name ?? d.who}
                      </span>
                    ) : null}
                    <span className={d.who ? 'text-neutral-100' : 'text-neutral-400 italic'}>{d.what}</span>
                  </li>
                );
              })}
              {scene.dialogueCount > scene.dialogue.length && (
                <li className="text-xs text-neutral-500">… {scene.dialogueCount - scene.dialogue.length} more lines</li>
              )}
            </ol>
          )}
        </div>
        )}
      </div>
    </div>
  );
}
