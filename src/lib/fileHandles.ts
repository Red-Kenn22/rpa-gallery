/**
 * Remembering picked files (File System Access API, Chrome 86+ desktop and
 * Chrome 132+ on Android). Files picked through `showOpenFilePicker` come with
 * handles that can be stored in IndexedDB and read again on a later visit,
 * after the browser re-confirms permission. Elsewhere the plain file input is
 * used and nothing is remembered.
 */

type ReadMode = { mode: 'read' };
interface PermissionedHandle extends FileSystemFileHandle {
  queryPermission?(d: ReadMode): Promise<PermissionState>;
  requestPermission?(d: ReadMode): Promise<PermissionState>;
}
type OpenPicker = (opts?: { multiple?: boolean; id?: string; excludeAcceptAllOption?: boolean }) => Promise<FileSystemFileHandle[]>;

const CLASSIC_KEY = 'rpa.classicPicker';

/** Which handle a File came from (Files are plain objects we can't extend). */
const handleOf = new WeakMap<File, FileSystemFileHandle>();

function picker(): OpenPicker | null {
  if (typeof window === 'undefined' || !window.isSecureContext) return null;
  const fn = (window as unknown as { showOpenFilePicker?: OpenPicker }).showOpenFilePicker;
  return typeof fn === 'function' ? fn.bind(window) : null;
}

/** The browser can hand out file handles at all. */
export function rememberSupported(): boolean {
  return picker() !== null;
}

export function classicPickerPreferred(): boolean {
  try {
    return localStorage.getItem(CLASSIC_KEY) === '1';
  } catch {
    return false;
  }
}

export function setClassicPickerPreferred(on: boolean): void {
  try {
    if (on) localStorage.setItem(CLASSIC_KEY, '1');
    else localStorage.removeItem(CLASSIC_KEY);
  } catch {
    /* storage unavailable */
  }
}

/** Pickers should use showOpenFilePicker (so files can be remembered). */
export function rememberEnabled(): boolean {
  return rememberSupported() && !classicPickerPreferred();
}

/** Opens the system picker. Resolves to null when the user cancels; throws if the picker itself fails. */
export async function pickWithHandles(): Promise<File[] | null> {
  const open = picker();
  if (!open) throw new Error('File System Access is not available');
  let handles: FileSystemFileHandle[];
  try {
    handles = await open({ multiple: true, id: 'rpa-gallery' });
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') return null;
    throw e;
  }
  const files = await Promise.all(handles.map((h) => h.getFile()));
  files.forEach((f, i) => handleOf.set(f, handles[i]));
  return files;
}

/** Handles for these files, or null if any of them wasn't picked through the system picker. */
export function handlesFor(files: File[]): FileSystemFileHandle[] | null {
  const out: FileSystemFileHandle[] = [];
  for (const f of files) {
    const h = handleOf.get(f);
    if (!h) return null;
    out.push(h);
  }
  return out.length ? out : null;
}

export type ReopenResult = { files: File[] } | { error: 'denied' | 'missing' | 'unavailable'; name?: string; detail: string };

/**
 * Reads remembered files again. Call from a tap: Chrome may ask the user to
 * allow access, which needs a user gesture.
 */
export async function filesFromHandles(handles: FileSystemFileHandle[]): Promise<ReopenResult> {
  const files: File[] = [];
  for (const raw of handles) {
    const h = raw as PermissionedHandle;
    let step = 'request';
    try {
      // Ask first, with nothing awaited before it: Chrome only shows the prompt straight after a tap.
      // (requestPermission answers 'granted' at once, without a prompt, when access is already allowed.)
      const perm: PermissionState = h.requestPermission
        ? await h.requestPermission({ mode: 'read' })
        : h.queryPermission
          ? await h.queryPermission({ mode: 'read' })
          : 'granted';
      if (perm !== 'granted') return { error: 'denied', name: h.name, detail: `permission ${perm}` };
      step = 'read';
      const f = await h.getFile();
      handleOf.set(f, h);
      files.push(f);
    } catch (e) {
      const err = e as Error;
      const detail = `${step}: ${err?.name ?? 'Error'}${err?.message ? ` – ${err.message}` : ''}`.slice(0, 200);
      if (err?.name === 'NotAllowedError' || err?.name === 'SecurityError') return { error: 'denied', name: h.name, detail };
      if (err?.name === 'NotFoundError' || err?.name === 'NotReadableError') return { error: 'missing', name: h.name, detail };
      return { error: 'unavailable', name: h.name, detail };
    }
  }
  return { files };
}
