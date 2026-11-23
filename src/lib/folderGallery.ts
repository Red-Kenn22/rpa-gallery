/**
 * Fallback gallery for archives without any game scripts (common: images in
 * archive.rpa, scripts as loose .rpyc files in game/). Groups images and
 * videos by folder so the archive is still browsable. Top-level folders act
 * as the "character" filter chips.
 */

import type { CharacterInfo, SceneInfo } from '../types';
import { mediaKind } from './sceneParser';

const MAX_PER_GROUP = 240;
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function prettySegment(s: string): string {
  const t = s.replace(/[_-]+/g, ' ').trim();
  return t ? t[0].toUpperCase() + t.slice(1) : s;
}

/** Path segments without the conventional "game/" and "images/" prefixes. */
function meaningful(dir: string): string[] {
  const segs = dir.split('/').filter(Boolean);
  while (segs.length && /^(game|images)$/i.test(segs[0])) segs.shift();
  return segs;
}

export interface FolderGallery {
  scenes: SceneInfo[];
  characters: CharacterInfo[];
  referenced: Set<string>;
}

export function buildFolderGallery(paths: Iterable<string>): FolderGallery {
  const groups = new Map<string, string[]>();
  for (const p of paths) {
    const kind = mediaKind(p);
    if (kind !== 'image' && kind !== 'video') continue;
    const slash = p.lastIndexOf('/');
    const dir = slash >= 0 ? p.slice(0, slash) : '';
    const list = groups.get(dir) ?? [];
    list.push(p);
    groups.set(dir, list);
  }

  const categories = new Map<string, CharacterInfo>();
  const scenes: SceneInfo[] = [];
  const referenced = new Set<string>();

  for (const dir of [...groups.keys()].sort(collator.compare)) {
    const files = groups.get(dir)!.sort(collator.compare);
    const segs = meaningful(dir);
    const catName = segs[0] ? prettySegment(segs[0]) : 'Top level';
    const catId = `folder:${(segs[0] ?? '').toLowerCase()}`;
    const baseTitle = segs.length ? segs.map(prettySegment).join(' / ') : 'Top level';
    const parts = Math.ceil(files.length / MAX_PER_GROUP);

    for (let part = 0; part < parts; part++) {
      const chunk = files.slice(part * MAX_PER_GROUP, (part + 1) * MAX_PER_GROUP);
      const videos = chunk.filter((p) => mediaKind(p) === 'video');
      const images = chunk.filter((p) => mediaKind(p) === 'image');
      chunk.forEach((p) => referenced.add(p));
      const thumb = videos[0] ? { path: videos[0], kind: 'video' as const } : { path: images[0], kind: 'image' as const };
      scenes.push({
        id: parts > 1 ? `${dir || '.'}#${part + 1}` : dir || '.',
        title: parts > 1 ? `${baseTitle} · ${part + 1}/${parts}` : baseTitle,
        file: dir || '(archive root)',
        line: 0,
        characters: [catId],
        speakers: [],
        backgrounds: [],
        images,
        videos,
        thumbnail: thumb,
        dialogue: [],
        dialogueCount: 0,
      });
      const cat = categories.get(catId) ?? { id: catId, name: catName, sceneCount: 0, lineCount: 0 };
      cat.sceneCount++;
      categories.set(catId, cat);
    }
  }

  const characters = [...categories.values()].sort((a, b) => b.sceneCount - a.sceneCount || collator.compare(a.name, b.name));
  return { scenes, characters, referenced };
}
