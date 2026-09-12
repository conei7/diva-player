import type { SoundMapPoint, SoundMapResponse } from './soundMap';

/**
 * Returns a deterministic in-browser fixture for checking the map UI without
 * starting PostgreSQL, Qdrant, or the recommender API. This is only called
 * from the development-only ?demo=1 path in SoundMapPage.
 */
export function getDemoSoundMap(seedSongId: number, mapVersion = 'demo-v1'): SoundMapResponse {
  const origin: SoundMapPoint = {
    songId: seedSongId,
    name: `デモ曲 ${seedSongId}`,
    artistString: 'DIVA Demo Producer',
    x: 0,
    y: 0,
    similarity: null,
  };
  const items: SoundMapPoint[] = [origin];
  for (let index = 1; index <= 28; index += 1) {
    const angle = index * 2.399963229728653;
    const radius = 0.12 + (index % 7) * 0.1;
    items.push({
      songId: seedSongId + index,
      name: `近傍デモ曲 ${seedSongId + index}`,
      artistString: index % 3 === 0 ? 'Demo Circle' : 'Demo Producer',
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius,
      similarity: Math.max(0.51, 0.99 - index * 0.014),
    });
  }
  return {
    mapVersion,
    generatedAt: '2026-09-12T00:00:00Z',
    method: 'デモ',
    coordinateCount: items.length,
    state: 'ready',
    origin,
    items,
  };
}
