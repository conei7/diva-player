import { describe, expect, it } from 'vitest';
import type { Song } from '../types/vocadb';
import { buildUserTasteProfile } from './userTasteProfile';

function song(id: number): Song {
  return {
    id, name: `song-${id}`, defaultName: `song-${id}`, defaultNameLanguage: 'Japanese', artistString: '',
    createDate: '2026-01-01', favoritedTimes: 0, lengthSeconds: 180, pvServices: 'Youtube', ratingScore: 0,
    songType: 'Original', status: 'Finished', version: 1,
  };
}

describe('buildUserTasteProfile', () => {
  it('prefers explicit positive ratings and manual completion for long-term seeds', () => {
    const now = Date.UTC(2026, 6, 11);
    const profile = buildUserTasteProfile(
      [{ song: song(1), playedAt: now - 20 * 24 * 60 * 60 * 1000 }, { song: song(2), playedAt: now - 8 * 60 * 60 * 1000 }],
      [],
      { '1': 5 },
      { '1': { skipCount: 0, completeCount: 3, manualCompleteCount: 3, removeCount: 0 } },
      now,
    );

    expect(profile.longTerm[0].song.id).toBe(1);
  });

  it('uses recent songs as short-term seeds and excludes dominant negative songs', () => {
    const now = Date.UTC(2026, 6, 11);
    const profile = buildUserTasteProfile(
      [{ song: song(1), playedAt: now - 60 * 60 * 1000 }, { song: song(2), playedAt: now - 30 * 60 * 1000 }],
      [],
      {},
      { '2': { skipCount: 3, completeCount: 0, removeCount: 1 } },
      now,
    );

    expect(profile.shortTerm.map(seed => seed.song.id)).toEqual([1]);
  });
});
