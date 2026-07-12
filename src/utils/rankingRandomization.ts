/** A per-page seed keeps a randomized ranking stable during one view. */
export type RankingSeed = number;

const MAX_SEED = 0x7fffffff;

export function createRankingSeed(): RankingSeed {
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const values = new Uint32Array(1);
    crypto.getRandomValues(values);
    return (values[0] & MAX_SEED) || 1;
  }
  return Math.max(1, Math.floor(Math.random() * MAX_SEED));
}

/** Deterministic pseudo-random value in [-1, 1] for a song and page seed. */
export function rankingNoise(seed: RankingSeed, songId: number): number {
  let value = (Math.imul(seed ^ songId, 0x45d9f3b) + 0x9e3779b9) | 0;
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
  value ^= value >>> 16;
  return (value / 0x7fffffff) * 2;
}
