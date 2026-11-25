/**
 * Framing for character portraits: finds the subject in an image (opaque
 * pixels on a transparent canvas, or pixels that differ from a plain
 * background) and picks a 3:4 crop around its top — head and shoulders for
 * a full-body render, the whole figure for a bust.
 */

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Portrait cards are 3:4 (width / height). */
export const PORTRAIT_ASPECT = 3 / 4;

/**
 * Bounding box of the subject in RGBA pixels, in pixel units, or null when the
 * picture has no plain background (an ordinary scene: frame it as a whole).
 */
export function subjectBox(px: Uint8ClampedArray, w: number, h: number): Box | null {
  if (w < 4 || h < 4) return null;
  const at = (x: number, y: number) => (y * w + x) * 4;
  const corners = [at(0, 0), at(w - 1, 0), at(0, h - 1), at(w - 1, h - 1)];
  const transparent = corners.filter((i) => px[i + 3] < 16).length >= 3;
  let bg: [number, number, number] | null = null;
  if (!transparent) {
    // A plain background: at least three corners of (nearly) the same colour.
    for (const c of corners) {
      const same = corners.filter((o) => Math.abs(px[o] - px[c]) + Math.abs(px[o + 1] - px[c + 1]) + Math.abs(px[o + 2] - px[c + 2]) < 36);
      if (same.length >= 3) {
        bg = [px[c], px[c + 1], px[c + 2]];
        break;
      }
    }
    if (!bg) return null;
  }
  const isSubject = (i: number) =>
    transparent ? px[i + 3] >= 48 : px[i + 3] >= 48 && Math.abs(px[i] - bg![0]) + Math.abs(px[i + 1] - bg![1]) + Math.abs(px[i + 2] - bg![2]) >= 48;

  const cols = new Uint32Array(w);
  const rows = new Uint32Array(h);
  let total = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (isSubject(at(x, y))) {
        cols[x]++;
        rows[y]++;
        total++;
      }
    }
  }
  // Nothing there, or the "background" is barely visible: treat as a normal picture.
  if (total < w * h * 0.01 || total > w * h * 0.92) return null;
  // Ignore specks: a column/row counts when a few percent of it is subject.
  const colMin = Math.max(1, Math.round(h * 0.02));
  const rowMin = Math.max(1, Math.round(w * 0.01));
  let x0 = 0;
  while (x0 < w && cols[x0] < colMin) x0++;
  let x1 = w - 1;
  while (x1 > x0 && cols[x1] < colMin) x1--;
  let y0 = 0;
  while (y0 < h && rows[y0] < rowMin) y0++;
  let y1 = h - 1;
  while (y1 > y0 && rows[y1] < rowMin) y1--;
  if (x0 >= x1 || y0 >= y1) return null;
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/** A 3:4 crop of a W×H image framing the top of `subject` (or the image's top centre without one). */
export function portraitCrop(subject: Box | null, W: number, H: number): Box {
  const s = subject ?? { x: 0, y: 0, w: W, h: H };
  const margin = Math.round(Math.max(s.w, s.h) * 0.04);
  let cw: number;
  let ch: number;
  if (s.w / s.h < PORTRAIT_ASPECT) {
    // Taller than the card: full width of the figure, cut below (keeps the face).
    cw = s.w + 2 * margin;
    ch = cw / PORTRAIT_ASPECT;
  } else {
    // Wider than the card: full height, centred on the subject.
    ch = s.h + 2 * margin;
    cw = ch * PORTRAIT_ASPECT;
  }
  if (cw > W) {
    cw = W;
    ch = cw / PORTRAIT_ASPECT;
  }
  if (ch > H) {
    ch = H;
    cw = ch * PORTRAIT_ASPECT;
  }
  const cx = s.x + s.w / 2;
  const x = Math.min(Math.max(0, cx - cw / 2), W - cw);
  const y = Math.min(Math.max(0, s.y - margin), H - ch);
  return { x: Math.round(x), y: Math.round(y), w: Math.round(cw), h: Math.round(ch) };
}
