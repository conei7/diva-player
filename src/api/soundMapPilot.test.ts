import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchSoundMapPilot } from './soundMapPilot';

afterEach(() => vi.unstubAllGlobals());

describe('fetchSoundMapPilot', () => {
  it('uses real pilot coordinates and orders neighbors by 2D distance', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        kind: 'diva-sound-map-pilot',
        mapVersion: 'pilot-1',
        generatedAt: '2026-09-12T00:00:00Z',
        method: 'PCA pilot',
        sourceCount: 100,
        sampleCount: 3,
        defaultSeedSongId: 10,
        items: [
          { songId: 10, name: 'A', artistString: 'P', x: 0, y: 0 },
          { songId: 20, name: 'B', artistString: 'Q', x: 0.8, y: 0 },
          { songId: 30, name: 'C', artistString: 'R', x: 0.1, y: 0 },
        ],
      }),
    }));

    const result = await fetchSoundMapPilot(10);

    expect(result.origin.songId).toBe(10);
    expect(result.items.map(point => point.songId)).toEqual([10, 30, 20]);
    expect(result.coordinateCount).toBe(3);
  });

  it('falls back to the exported default seed', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        kind: 'diva-sound-map-pilot',
        mapVersion: 'pilot-1',
        generatedAt: '2026-09-12T00:00:00Z',
        method: 'PCA pilot',
        sourceCount: 100,
        sampleCount: 1,
        defaultSeedSongId: 20,
        items: [{ songId: 20, name: 'B', artistString: 'Q', x: 0, y: 0 }],
      }),
    }));

    expect((await fetchSoundMapPilot(999)).origin.songId).toBe(20);
  });
});
