import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SoundMapResponse } from '../api/soundMap';
import type { Song } from '../types/vocadb';

const mocks = vi.hoisted(() => ({
  fetchSoundMap: vi.fn(),
  getSongsByIds: vi.fn(),
}));

vi.mock('../api/soundMap', async importOriginal => ({
  ...(await importOriginal<typeof import('../api/soundMap')>()),
  fetchSoundMap: mocks.fetchSoundMap,
}));
vi.mock('../api/vocadb', () => ({ getSongsByIds: mocks.getSongsByIds }));

import { SoundMapRequestError } from '../api/soundMap';
import {
  nextSoundMapQueueSongs,
  rememberSoundMapQueueSongs,
  resetSoundMapQueueForTests,
  SOUND_MAP_NEIGHBOR_LIMIT,
} from './soundMapQueue';

function song(id: number, playable = true): Song {
  return {
    id,
    name: `Song ${id}`,
    artistString: 'Fixture',
    createDate: '2026-01-01T00:00:00Z',
    defaultName: `Song ${id}`,
    defaultNameLanguage: 'English',
    favoritedTimes: 0,
    lengthSeconds: 200,
    pvs: playable
      ? [{ author: '', disabled: false, id: id * 10, length: 200, name: 'pv', pvId: `pv${id}`, service: 'Youtube', pvType: 'Original', url: '' }]
      : [],
    pvServices: playable ? 'Youtube' : 'Nothing',
    ratingScore: 0,
    songType: 'Original',
    status: 'Finished',
    version: 1,
  };
}

function soundMap(originId: number, neighborIds: number[]): SoundMapResponse {
  const point = (songId: number, similarity: number | null) => ({ songId, name: `Song ${songId}`, artistString: 'Fixture', x: 0, y: 0, similarity });
  return {
    mapVersion: 'v1',
    generatedAt: '2026-11-01T00:00:00Z',
    method: 'pca',
    coordinateCount: 1000,
    state: neighborIds.length > 0 ? 'ready' : 'no_mapped_neighbors',
    origin: point(originId, null),
    // The API puts the origin first, then the neighbours most similar first.
    items: [point(originId, null), ...neighborIds.map((id, index) => point(id, 1 - index / 1000))],
  };
}

function range(start: number, count: number): number[] {
  return Array.from({ length: count }, (_, index) => start + index);
}

describe('sound-map queue continuation', () => {
  const maps = new Map<number, number[]>();
  const unplayable = new Set<number>();

  beforeEach(() => {
    resetSoundMapQueueForTests();
    maps.clear();
    unplayable.clear();
    mocks.fetchSoundMap.mockReset().mockImplementation(async (id: number) => {
      const neighbors = maps.get(id);
      if (!neighbors) throw new SoundMapRequestError('not mapped', 404, 'seed_not_mapped');
      return soundMap(id, neighbors);
    });
    mocks.getSongsByIds.mockReset().mockImplementation(async (ids: number[]) => ids.map(id => song(id, !unplayable.has(id))));
  });

  it('goes on after the listed songs in the same nearest order', async () => {
    maps.set(1, range(100, 200));
    const listed = new Set(range(100, 20)); // 「すべて再生」 queued the first 20 rows.

    const next = await nextSoundMapQueueSongs({ originSongId: 1, excludeIds: listed, count: 12 });

    expect(next.map(item => item.id)).toEqual(range(120, 12));
    expect(mocks.fetchSoundMap).toHaveBeenCalledWith(1, expect.objectContaining({ limit: SOUND_MAP_NEIGHBOR_LIMIT }));
  });

  it('skips unplayable and queued songs and never offers a song again once it was queued', async () => {
    maps.set(1, range(100, 200));
    unplayable.add(101);
    const first = await nextSoundMapQueueSongs({ originSongId: 1, excludeIds: new Set([100]), count: 3 });
    expect(first.map(item => item.id)).toEqual([102, 103, 104]);
    rememberSoundMapQueueSongs(1, first);

    // 103 was removed from the queue: it is no longer excluded, but it does not come back.
    const second = await nextSoundMapQueueSongs({ originSongId: 1, excludeIds: new Set([100, 102, 104]), count: 3 });
    expect(second.map(item => item.id)).toEqual([105, 106, 107]);
    expect(mocks.fetchSoundMap).toHaveBeenCalledTimes(1);
  });

  it('widens outward from the nearest songs once the origin’s 200 are used up', async () => {
    const ring1 = range(100, 200);
    maps.set(1, ring1);
    maps.set(100, [1, 101, 102, 500, 501]); // the nearest song's own neighbours come next
    maps.set(101, [100, 501, 502]);

    const next = await nextSoundMapQueueSongs({ originSongId: 1, excludeIds: new Set(ring1), count: 3 });

    // The origin itself is not replayed, and 501 (near two of the nearest songs) comes once.
    expect(next.map(item => item.id)).toEqual([500, 501, 502]);
  });

  it('bounds the map requests of one refill and continues the walk on the next one', async () => {
    const ring1 = range(100, 200);
    maps.set(1, ring1);
    // Neighbours whose lists hold nothing new.
    ring1.forEach(id => maps.set(id, [1, ...ring1.slice(0, 5)]));
    maps.set(150, [900]);

    const first = await nextSoundMapQueueSongs({ originSongId: 1, excludeIds: new Set(ring1), count: 3 });
    expect(first).toEqual([]);
    const requestsAfterFirst = mocks.fetchSoundMap.mock.calls.length;
    expect(requestsAfterFirst).toBeLessThanOrEqual(8);

    let found: Song[] = [];
    for (let refill = 0; refill < 20 && found.length === 0; refill++) {
      found = await nextSoundMapQueueSongs({ originSongId: 1, excludeIds: new Set(ring1), count: 3 });
    }
    expect(found.map(item => item.id)).toEqual([900]);
    // Each list is loaded once.
    const loaded = mocks.fetchSoundMap.mock.calls.map(([id]) => id as number);
    expect(new Set(loaded).size).toBe(loaded.length);
  });

  it('starts a new walk for another origin', async () => {
    maps.set(1, [10, 11]);
    maps.set(2, [20, 21]);
    expect((await nextSoundMapQueueSongs({ originSongId: 1, excludeIds: new Set(), count: 1 })).map(item => item.id)).toEqual([10]);
    expect((await nextSoundMapQueueSongs({ originSongId: 2, excludeIds: new Set(), count: 2 })).map(item => item.id)).toEqual([20, 21]);
  });

  it('reports a failed map request instead of returning ordinary recommendations', async () => {
    mocks.fetchSoundMap.mockRejectedValueOnce(new SoundMapRequestError('down', 503, 'sound_map_dependency_unavailable'));
    await expect(nextSoundMapQueueSongs({ originSongId: 1, excludeIds: new Set(), count: 3 })).rejects.toThrow('down');
  });

  it('retries songs the batch API did not return on a later refill', async () => {
    maps.set(1, [10, 11, 12]);
    mocks.getSongsByIds.mockImplementationOnce(async (ids: number[]) => ids.filter(id => id !== 10).map(id => song(id)));
    const first = await nextSoundMapQueueSongs({ originSongId: 1, excludeIds: new Set(), count: 3 });
    expect(first.map(item => item.id)).toEqual([11, 12]);
    rememberSoundMapQueueSongs(1, first);
    const second = await nextSoundMapQueueSongs({ originSongId: 1, excludeIds: new Set([11, 12]), count: 3 });
    expect(second.map(item => item.id)).toEqual([10]);
  });
});
