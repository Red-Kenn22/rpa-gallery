/** Cache key: `${name}_${size}_${lastModified}` per source file, sorted, joined by "|". */
export function cacheKeyFor(files: { name: string; size: number; lastModified: number }[]): string {
  return files
    .map((f) => `${f.name}_${f.size}_${f.lastModified}`)
    .sort()
    .join('|');
}
