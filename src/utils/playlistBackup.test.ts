import { describe, expect, it } from 'vitest';
import { parsePlaylistBackup } from './playlistBackup';

describe('smart playlist backup compatibility', () => {
  it('fills new options for legacy playlist exports', () => {
    const parsed = parsePlaylistBackup({
      folders: [],
      playlists: [{
        name: 'legacy smart playlist',
        songs: [{ id: 1, name: 'song' }],
        smartRule: {
          minYoutubeViews: 0,
          minNicoViews: 0,
          excludedSongTypes: [],
        },
      }],
    });

    expect(parsed?.playlists[0].smartRule).toMatchObject({
      maxSongs: 200,
      sortBy: 'FavoritedTimes',
    });
  });

  it('preserves explicit limit and sort choices', () => {
    const parsed = parsePlaylistBackup({
      folders: [],
      playlists: [{
        name: 'custom smart playlist',
        songs: [{ id: 1, name: 'song' }],
        smartRule: {
          minYoutubeViews: 0,
          minNicoViews: 0,
          excludedSongTypes: [],
          maxSongs: 50,
          sortBy: 'PublishDate',
        },
      }],
    });

    expect(parsed?.playlists[0].smartRule).toMatchObject({
      maxSongs: 50,
      sortBy: 'PublishDate',
    });
  });

  it('preserves valid YouTube sync metadata while ignoring malformed links', () => {
    const parsed = parsePlaylistBackup({
      folders: [],
      playlists: [
        {
          name: 'linked',
          songs: [{ id: 1, name: 'song' }],
          youtubeSync: {
            playlistId: 'PL1234567890',
            sourceUrl: 'https://www.youtube.com/playlist?list=PL1234567890',
            enabled: true,
            intervalHours: 24,
            lastStatus: 'success',
          },
        },
        {
          name: 'invalid',
          songs: [{ id: 2, name: 'song' }],
          youtubeSync: { playlistId: 'bad', sourceUrl: '', enabled: true, intervalHours: 24 },
        },
      ],
    });

    expect(parsed?.playlists[0].youtubeSync?.playlistId).toBe('PL1234567890');
    expect(parsed?.playlists[1].youtubeSync).toBeUndefined();
  });
});
