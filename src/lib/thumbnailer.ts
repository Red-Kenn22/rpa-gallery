/**
 * Thumbnail generation for images and video, tuned for phones:
 *
 *  – Media is read through lazy sliced Blobs (no archive bytes in memory).
 *  – Videos: hidden muted <video>, seek to ~1.5 s, draw the frame to a canvas,
 *    export a small JPEG data URL, then revoke the object URL and detach the
 *    source so the hardware decoder is released immediately.
 *  – A small queue caps concurrent decodes (iOS limits live video decoders)
 *    and drops requests for cards that scrolled away before their turn.
 */

export interface ThumbOptions {
  /** Longest edge of the output, in pixels. */
  maxSize?: number;
  quality?: number;
  /** Seek position for videos, in seconds. */
  seek?: number;
  timeoutMs?: number;
}

const DEFAULTS: Required<ThumbOptions> = { maxSize: 480, quality: 0.72, seek: 1.5, timeoutMs: 12000 };

function drawScaled(source: CanvasImageSource, w: number, h: number, opts: Required<ThumbOptions>): string {
  if (!w || !h) throw new Error('Media has no dimensions');
  const scale = Math.min(1, opts.maxSize / Math.max(w, h));
  const cw = Math.max(1, Math.round(w * scale));
  const ch = Math.max(1, Math.round(h * scale));
  const canvas = document.createElement('canvas');
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas unavailable');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, cw, ch);
  const url = canvas.toDataURL('image/jpeg', opts.quality);
  // Release the backing store right away (matters on iOS, which caps total canvas memory).
  canvas.width = canvas.height = 0;
  return url;
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} timed out`)), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

export async function imageThumbnail(blob: Blob, options: ThumbOptions = {}): Promise<string> {
  const opts = { ...DEFAULTS, ...options };
  const url = URL.createObjectURL(blob);
  const img = new Image();
  img.decoding = 'async';
  try {
    img.src = url;
    await withTimeout(
      img.decode ? img.decode() : new Promise<void>((res, rej) => { img.onload = () => res(); img.onerror = () => rej(new Error('Image failed to load')); }),
      opts.timeoutMs,
      'Image decode',
    );
    return drawScaled(img, img.naturalWidth, img.naturalHeight, opts);
  } finally {
    img.removeAttribute('src');
    URL.revokeObjectURL(url);
  }
}

export async function videoThumbnail(blob: Blob, options: ThumbOptions = {}): Promise<string> {
  const opts = { ...DEFAULTS, ...options };
  const url = URL.createObjectURL(blob);
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.setAttribute('playsinline', '');
  video.setAttribute('muted', '');
  video.preload = 'auto';

  const once = (event: string) =>
    new Promise<void>((resolve, reject) => {
      const ok = () => { cleanup(); resolve(); };
      const fail = () => { cleanup(); reject(new Error(video.error?.message || 'Video cannot be decoded on this device')); };
      const cleanup = () => { video.removeEventListener(event, ok); video.removeEventListener('error', fail); };
      video.addEventListener(event, ok, { once: true });
      video.addEventListener('error', fail, { once: true });
    });

  try {
    const loaded = once('loadeddata');
    video.src = url;
    video.load();
    await withTimeout(loaded, opts.timeoutMs, 'Video load');
    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    const target = duration > 0 ? Math.min(opts.seek, duration * 0.4) : 0;
    if (target > 0.05) {
      const seeked = once('seeked');
      video.currentTime = target;
      await withTimeout(seeked, opts.timeoutMs, 'Video seek');
    }
    // Some WebKit builds report 'seeked' before the frame is painted.
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    return drawScaled(video, video.videoWidth, video.videoHeight, opts);
  } finally {
    video.pause();
    video.removeAttribute('src');
    video.load(); // detaches the decoder
    URL.revokeObjectURL(url);
  }
}

export function makeThumbnail(blob: Blob, kind: 'image' | 'video', options?: ThumbOptions): Promise<string> {
  return kind === 'video' ? videoThumbnail(blob, options) : imageThumbnail(blob, options);
}

// ─── Queue ──────────────────────────────────────────────────────────────────

interface Job {
  run: () => Promise<string>;
  resolve: (v: string) => void;
  reject: (e: unknown) => void;
  signal?: AbortSignal;
}

export class ThumbnailQueue {
  private queue: Job[] = [];
  private active = 0;
  private readonly concurrency: number;

  constructor(concurrency = 2) {
    this.concurrency = concurrency;
  }

  /** Newest requests run first: they're the cards the user is looking at now. */
  add(run: () => Promise<string>, signal?: AbortSignal): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'));
      this.queue.push({ run, resolve, reject, signal });
      this.pump();
    });
  }

  private pump(): void {
    while (this.active < this.concurrency && this.queue.length) {
      const job = this.queue.pop()!;
      if (job.signal?.aborted) {
        job.reject(new DOMException('Aborted', 'AbortError'));
        continue;
      }
      this.active++;
      job
        .run()
        .then(job.resolve, job.reject)
        .finally(() => {
          this.active--;
          this.pump();
        });
    }
  }
}

export const thumbnailQueue = new ThumbnailQueue(2);
