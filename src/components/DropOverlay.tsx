import { useEffect, useRef, useState } from 'react';

/** Desktop drag-and-drop: drop files anywhere on the window to open them. */
export function DropOverlay({ onFiles, disabled }: { onFiles: (files: File[]) => void; disabled?: boolean }) {
  const [over, setOver] = useState(false);
  const depth = useRef(0);
  const cb = useRef(onFiles);
  cb.current = onFiles;

  useEffect(() => {
    if (disabled) return;
    const hasFiles = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth.current++;
      setOver(true);
    };
    const overFn = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault(); // allow drop
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    };
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (!depth.current) setOver(false);
    };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth.current = 0;
      setOver(false);
      const files = [...(e.dataTransfer?.files ?? [])];
      if (files.length) cb.current(files);
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragover', overFn);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragover', overFn);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', drop);
    };
  }, [disabled]);

  if (!over) return null;
  return (
    <div className="pointer-events-none fixed inset-0 z-[80] grid place-items-center bg-neutral-950/80 p-6" data-drop-overlay>
      <div className="grid size-full place-items-center rounded-3xl border-2 border-dashed border-rose-400/70 text-center">
        <div>
          <p className="text-lg font-semibold">Drop archive files to open</p>
          <p className="mt-1 text-sm text-neutral-400">.rpa, .apk, .rpyc, .rpy</p>
        </div>
      </div>
    </div>
  );
}
