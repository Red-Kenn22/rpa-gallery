import type { MediaKind } from '../types';
import { extensionOf } from './rpaParser';

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'avif', 'bmp', 'gif', 'tga', 'svg']);
const VIDEO_EXT = new Set(['webm', 'mp4', 'm4v', 'ogv', 'mkv', 'avi', 'mpg', 'mpeg', 'mov']);
const AUDIO_EXT = new Set(['ogg', 'opus', 'mp3', 'wav', 'flac']);

export function mediaKind(path: string): MediaKind {
  const ext = extensionOf(path);
  if (IMAGE_EXT.has(ext)) return 'image';
  if (VIDEO_EXT.has(ext)) return 'video';
  if (AUDIO_EXT.has(ext)) return 'audio';
  return 'other';
}

export const isVisual = (p: string) => {
  const k = mediaKind(p);
  return k === 'image' || k === 'video';
};
