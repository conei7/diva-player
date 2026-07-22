/**
 * VocaDB may attach the same character once per voicebank. Collapse those
 * duplicates for display without changing the song's underlying artist data.
 */
export function formatDistinctArtistNames(names: Array<string | null | undefined>): string {
  const distinct = [...new Set(
    names.map(name => name?.trim()).filter((name): name is string => Boolean(name)),
  )];
  const nameSet = new Set(distinct);
  const variantBases = new Set<string>();

  for (const name of distinct) {
    const match = name.match(/^(.+?)\s+\([^)]+\)$/u);
    if (match?.[1] && nameSet.has(match[1])) variantBases.add(match[1]);
  }

  return distinct
    .filter(name => {
      const match = name.match(/^(.+?)\s+\([^)]+\)$/u);
      return !match?.[1] || !variantBases.has(match[1]);
    })
    .map(name => variantBases.has(name) ? `${name}（複数音源）` : name)
    .join(', ');
}
