import { describe, expect, it } from 'vitest';
import { formatTotalDuration, parsePlaylistBackup, uniquePlaylistName } from './playlistBackup';

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

  it('preserves valid NicoNico sync metadata while ignoring malformed links', () => {
    const parsed = parsePlaylistBackup({
      folders: [],
      playlists: [
        {
          name: 'nico linked',
          songs: [{ id: 1, name: 'song' }],
          nicoSync: {
            sourceKind: 'series',
            sourceId: '359827',
            sourceUrl: 'https://www.nicovideo.jp/series/359827',
            enabled: true,
            intervalHours: 24,
            lastStatus: 'partial',
          },
        },
        {
          name: 'invalid',
          songs: [{ id: 2, name: 'song' }],
          nicoSync: { sourceKind: 'video', sourceId: 'sm9', sourceUrl: '', enabled: true, intervalHours: 24 },
        },
      ],
    });

    expect(parsed?.playlists[0].nicoSync).toMatchObject({ sourceKind: 'series', sourceId: '359827' });
    expect(parsed?.playlists[1].nicoSync).toBeUndefined();
  });
});

describe('playlist names and totals', () => {
  it('keeps the original name and only numbers it when it is already taken', () => {
    expect(uniquePlaylistName('作業用BGM', ['後で聴く'])).toBe('作業用BGM');
    expect(uniquePlaylistName('作業用BGM', ['作業用BGM'])).toBe('作業用BGM (2)');
    expect(uniquePlaylistName(' 作業用BGM ', ['作業用BGM', '作業用BGM (2)'])).toBe('作業用BGM (3)');
  });

  it('formats the total length in the UI language', () => {
    expect(formatTotalDuration(4_740)).toBe('1時間19分');
    expect(formatTotalDuration(2_059, 'ja')).toBe('34分');
    expect(formatTotalDuration(4_740, 'en')).toBe('1 hr 19 min');
  });
});
