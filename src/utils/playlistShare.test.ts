import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Playlist, Song } from '../types/vocadb';
import {
  MAX_PLAYLIST_SHARE_URL_LENGTH,
  createPlaylistSharePayload,
  createPlaylistShareUrl,
  decodePlaylistShare,
  encodePlaylistShare,
  orderSharedSongs,
} from './playlistShare';

function song(id: number): Song {
  return {
    id,
    name: `曲${id}`,
    defaultName: `曲${id}`,
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
  };
}

const playlist: Playlist = {
  id: 'p1',
  name: '作業用ミク',
  description: '共有テスト',
  songs: [song(10), song(11)],
  createdAt: 1,
  updatedAt: 1,
};

function toBase64Url(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

describe('playlistShare', () => {
  it('round-trips Japanese playlist data as song ids', () => {
    const decoded = decodePlaylistShare(encodePlaylistShare(playlist));
    expect(decoded?.name).toBe('作業用ミク');
    expect(decoded?.description).toBe('共有テスト');
    expect(decoded?.songIds).toEqual([10, 11]);
    expect(decoded?.songs).toBeUndefined();
  });

  it('shares the given (shown) name instead of the saved one', () => {
    expect(decodePlaylistShare(encodePlaylistShare({ ...playlist, name: '後で聴く' }, 'Listen later'))?.name).toBe('Listen later');
  });

  it('still opens version 1 links that carry the songs', () => {
    const legacy = toBase64Url({ kind: 'diva-player-playlist-share', version: 1, name: '旧形式', songs: [song(5), song(6)] });
    const decoded = decodePlaylistShare(legacy);
    expect(decoded?.name).toBe('旧形式');
    expect(decoded?.songIds).toEqual([5, 6]);
    expect(decoded?.songs?.map(item => item.id)).toEqual([5, 6]);
  });

  it('rejects malformed or incompatible payloads', () => {
    expect(decodePlaylistShare('invalid')).toBeNull();
    expect(createPlaylistSharePayload(playlist).version).toBe(2);
    expect(decodePlaylistShare(toBase64Url({ kind: 'diva-player-playlist-share', version: 2, name: 'x', songIds: [1, -2] }))).toBeNull();
    expect(decodePlaylistShare(toBase64Url({ kind: 'diva-player-playlist-share', version: 3, name: 'x', songIds: [1] }))).toBeNull();
    expect(decodePlaylistShare(toBase64Url({ kind: 'other', version: 2, name: 'x', songIds: [1] }))).toBeNull();
  });

  it('keeps the shared order and drops songs that no longer exist', () => {
    expect(orderSharedSongs([3, 1, 2], [song(1), song(3)]).map(item => item.id)).toEqual([3, 1]);
  });

  describe('share URL', () => {
    afterEach(() => vi.unstubAllGlobals());

    it('opens the playlists page under the app base path', () => {
      vi.stubGlobal('window', { location: { origin: 'https://example.com' } });
      const base = import.meta.env.BASE_URL.replace(/\/$/, '');
      const url = new URL(createPlaylistShareUrl(playlist) ?? '');
      expect(`${url.origin}${url.pathname}`).toBe(`https://example.com${base}/playlists`);
      expect(decodePlaylistShare(url.searchParams.get('share') ?? '')?.name).toBe('作業用ミク');
    });

    it('stays short for an ordinary playlist', () => {
      vi.stubGlobal('window', { location: { origin: 'https://example.com' } });
      const songs = Array.from({ length: 200 }, (_, index) => song(900_000 + index));
      expect((createPlaylistShareUrl({ ...playlist, songs }) ?? '').length).toBeLessThan(3_000);
    });

    it('leaves out a long description, and gives up when the songs alone do not fit', () => {
      vi.stubGlobal('window', { location: { origin: 'https://example.com' } });
      const longDescription = 'あ'.repeat(2_000);
      const url = createPlaylistShareUrl({ ...playlist, description: longDescription });
      expect(url).not.toBeNull();
      expect(url!.length).toBeLessThanOrEqual(MAX_PLAYLIST_SHARE_URL_LENGTH);
      const decoded = decodePlaylistShare(new URL(url!).searchParams.get('share') ?? '');
      expect(decoded?.description).toBeUndefined();
      expect(decoded?.songIds).toEqual([10, 11]);

      const huge = Array.from({ length: 2_000 }, (_, index) => song(9_000_000 + index));
      expect(createPlaylistShareUrl({ ...playlist, songs: huge })).toBeNull();
    });
  });
});
