import { describe, expect, it } from 'vitest';
import type { Playlist } from '../types/vocadb';
import { createPlaylistSharePayload, decodePlaylistShare, encodePlaylistShare } from './playlistShare';

const playlist: Playlist = {
  id: 'p1',
  name: '作業用ミク',
  description: '共有テスト',
  songs: [{
    id: 10,
    name: '曲',
    defaultName: '曲',
    defaultNameLanguage: 'Japanese',
    artistString: 'P',
    createDate: '2026-01-01',
    favoritedTimes: 0,
    lengthSeconds: 120,
    pvServices: 'Youtube',
    ratingScore: 0,
    songType: 'Original',
    status: 'Finished',
    version: 1,
    pvs: [{ author: 'a', disabled: false, id: 1, length: 120, name: 'pv', pvId: 'x', service: 'Youtube', pvType: 'Original', url: 'https://youtube.com/watch?v=x' }],
  }],
  createdAt: 1,
  updatedAt: 1,
};

describe('playlistShare', () => {
  it('round-trips Japanese playlist data', () => {
    const decoded = decodePlaylistShare(encodePlaylistShare(playlist));
    expect(decoded?.name).toBe('作業用ミク');
    expect(decoded?.songs[0]?.id).toBe(10);
    expect(decoded?.songs[0]?.artists).toBeUndefined();
  });

  it('rejects malformed or incompatible payloads', () => {
    expect(decodePlaylistShare('invalid')).toBeNull();
    expect(createPlaylistSharePayload(playlist).version).toBe(1);
  });
});
