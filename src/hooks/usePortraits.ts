import { useCallback, useState } from 'react';
import type { CharacterInfo } from '../types';

/** Portrait choices made by the user, remembered per game (index key). */
export function usePortraits(indexKey: string | undefined) {
  const storageKey = indexKey ? `rpa.portraits.${indexKey}` : null;
  const [overrides, setOverrides] = useState<Record<string, string>>(() => read(storageKey));
  const [loadedFor, setLoadedFor] = useState(storageKey);
  if (loadedFor !== storageKey) {
    setLoadedFor(storageKey);
    setOverrides(read(storageKey));
  }

  const portraitOf = useCallback((c: CharacterInfo): string | undefined => overrides[c.id] ?? c.portrait, [overrides]);

  const setPortrait = useCallback(
    (charId: string, path: string | null) => {
      setOverrides((cur) => {
        const next = { ...cur };
        if (path) next[charId] = path;
        else delete next[charId];
        if (storageKey) {
          try {
            localStorage.setItem(storageKey, JSON.stringify(next));
          } catch {
            /* storage unavailable */
          }
        }
        return next;
      });
    },
    [storageKey],
  );

  return { portraitOf, setPortrait, isCustom: (id: string) => id in overrides };
}

function read(key: string | null): Record<string, string> {
  if (!key) return {};
  try {
    return JSON.parse(localStorage.getItem(key) ?? '{}') ?? {};
  } catch {
    return {};
  }
}
