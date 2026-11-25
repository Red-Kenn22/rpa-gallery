import { useRef, type ReactNode } from 'react';
import { pickWithHandles, rememberEnabled } from '../lib/fileHandles';

/**
 * Opens files. Where the browser supports it (Chrome), uses the system picker
 * so the files can be remembered for one-tap reopening; otherwise a plain
 * <input type="file" multiple>. No `accept` filter on purpose: iOS greys out
 * file types it doesn't recognise (like .rpa) when one is set.
 */
export function FilePickerButton({
  onFiles,
  className,
  children,
  label = 'Open archive files',
}: {
  onFiles: (files: File[]) => void;
  className?: string;
  children: ReactNode;
  label?: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <button
        type="button"
        className={className}
        onClick={async () => {
          if (!rememberEnabled()) return input.current?.click();
          try {
            const files = await pickWithHandles();
            if (files?.length) onFiles(files);
          } catch {
            input.current?.click(); // the system picker failed: fall back to the classic one
          }
        }}
        aria-label={label}
      >
        {children}
      </button>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          const files = Array.from(e.currentTarget.files ?? []);
          e.currentTarget.value = ''; // allow re-picking the same files
          if (files.length) onFiles(files);
        }}
      />
    </>
  );
}
