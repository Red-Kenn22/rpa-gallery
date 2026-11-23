/** Normalises Ren'Py colours ("#f80", "#ff8800", "#ff8800cc") to #rrggbb, or null. */
export function normalizeHex(color: string | undefined): string | null {
  if (!color) return null;
  const m = /^#([0-9a-f]{3,8})$/i.exec(color.trim());
  if (!m) return null;
  const h = m[1];
  if (h.length === 3 || h.length === 4) return `#${h[0]}${h[0]}${h[1]}${h[1]}${h[2]}${h[2]}`;
  if (h.length === 6 || h.length === 8) return `#${h.slice(0, 6)}`;
  return null;
}

/** Text colour plus a translucent background tint for a character tag. */
export function tagColors(color: string | undefined): { color: string; background: string } {
  const hex = normalizeHex(color);
  return hex ? { color: hex, background: `${hex}26` } : { color: '#d4d4d4', background: 'rgba(255,255,255,0.07)' };
}

/** 1.2 GB / 34 MB / 512 KB */
export function formatBytes(n: number): string {
  if (n >= 1073741824) return `${(n / 1073741824).toFixed(1)} GB`;
  if (n >= 1048576) return `${(n / 1048576).toFixed(n >= 104857600 ? 0 : 1)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}
