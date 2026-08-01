import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Song } from '../types/vocadb';

const mocks = vi.hoisted(() => ({
  getPlayedSongIds: vi.fn<() => Promise<Set<number>>>(),
  getDigRecommendedSongs: vi.fn(),
}));
const { getPlayedSongIds, getDigRecommendedSongs } = mocks;

vi.mock('./historyDatabase', () => ({ getPlayedSongIds: mocks.getPlayedSongIds }));
vi.mock('../api/vocadb', () => ({ getDigRecommendedSongs: mocks.getDigRecommendedSongs }));

import {
  buildDigKnownIds,
  buildDigTasteSeeds,
  filterDigCandidates,
  generateDigPlaylist,
} from './digPlaylist';

function song(id: number): Song {
  return {
    id,
    name: `曲${id}`,
    defaultName: `曲${id}`,
    defaultNameLanguage: 'Japanese',
    artistString: `P${id}`,
    createDate: '2026-01-01',
    favoritedTimes: id,
    lengthSeconds: 120,
    pvServices: 'Youtube',
    ratingScore: 0,
    songType: 'Original',
    status: 'Finished',
    version: 1,
    artists: [{
      id,
      name: '歌唱',
      categories: 'Vocalist',
      effectiveRoles: '',
      isCustomName: false,
      isSupport: false,
      roles: '',
      artist: {
        id,
        name: '歌唱',
        additionalNames: '',
        artistType: 'Vocaloid',
        deleted: false,
        status: 'Finished',
        version: 1,
      },
    }],
  };
}

describe('Dig playlist candidate preparation', () => {
  beforeEach(() => {
    getPlayedSongIds.mockReset();
    getPlayedSongIds.mockResolvedValue(new Set([2]));
    getDigRecommendedSongs.mockReset();
  });

  it('builds weighted seeds from ratings, history, and saved playlists', () => {
    const seeds = buildDigTasteSeeds({
      historyEntries: [{ song: song(1), playedAt: Date.now() - 60_000 }],
      playlists: [{ songs: [song(3)] }],
      ratings: { '1': 5, '4': 4 },
      implicitFeedback: { '1': { skipCount: 0, completeCount: 2, manualCompleteCount: 1, removeCount: 0 } },
    }, 12);

    expect(seeds.map(seed => seed.songId)).toEqual(expect.arrayContaining([1, 3, 4]));
    expect(seeds.every(seed => seed.weight > 0 && seed.weight <= 1)).toBe(true);
  });

  it('gives a five-star song substantially more seed weight than incidental playback', () => {
    const now = Date.now();
    const seeds = buildDigTasteSeeds({
      historyEntries: [
        { song: song(1), playedAt: now },
        { song: song(2), playedAt: now },
      ],
      playlists: [],
      ratings: { '1': 5 },
      implicitFeedback: {},
    }, 12, now);
    const fiveStar = seeds.find(seed => seed.songId === 1);
    const incidental = seeds.find(seed => seed.songId === 2);

    expect(fiveStar?.weight).toBe(1);
    expect(incidental).toBeUndefined();
  });

  it('does not turn discovery or autoplay completion into a taste seed', () => {
    const now = Date.now();
    const seeds = buildDigTasteSeeds({
      historyEntries: [{ song: song(1), playedAt: now }],
      playlists: [],
      ratings: {},
      implicitFeedback: {
        '1': {
          skipCount: 0,
          completeCount: 4,
          autoCompleteCount: 2,
          discoveryCompleteCount: 2,
          removeCount: 0,
        },
      },
    }, 12, now);

    expect(seeds).toEqual([]);
  });

  it('treats every playback, rating, and feedback item as known', () => {
    const known = buildDigKnownIds([1, 2], { '3': 4, '0': 5 }, {
      '4': { skipCount: 1, completeCount: 0, removeCount: 0 },
      '5': { skipCount: 0, completeCount: 0, removeCount: 0 },
    });
    expect([...known].sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
  });

  it('filters heard, duplicate, non-voice, and global-filtered songs', () => {
    const nonVoice = { ...song(4), artists: [] };
    const result = filterDigCandidates(
      [song(1), song(2), song(1), nonVoice],
      new Set([2]),
      { enabled: true, minYoutubeViews: 10, minNicoViews: 0, excludedSongTypes: [], cooldownHours: 0, excludeRatedFromDiscovery: false },
    );
    expect(result.map(item => item.id)).toEqual([]);
  });

  it('pages candidates and never returns a played song', async () => {
    getDigRecommendedSongs
      .mockResolvedValueOnce([song(2), song(1), song(3), ...Array.from({ length: 97 }, () => song(3))])
      .mockResolvedValueOnce([song(3), song(4)]);
    const result = await generateDigPlaylist({
      historyEntries: [{ song: song(2), playedAt: Date.now() }],
      playlists: [],
      ratings: {},
      implicitFeedback: {},
    }, { generationSeed: 7, targetCount: 3 });

    expect(result.songs.map(item => item.id)).toEqual([1, 3, 4]);
    expect(getDigRecommendedSongs).toHaveBeenCalledTimes(2);
    expect(getDigRecommendedSongs.mock.calls[0][2]).toContain(2);
  });
});
