import { describe, expect, it } from 'vitest';
import { WATCH_LATER_ID } from '../../../stores/playlistStore';
import type { Playlist, Song } from '../../../types/vocadb';
import { buildQuickTiles, greetingFor, QUICK_TILE_COUNT } from './musicHomeTiles';

const song = { id: 1, name: 'Song' } as Song;
function playlist(id: string, songs: Song[] = [song]): Playlist {
  return { id, name: `List ${id}`, songs } as unknown as Playlist;
}
const labels = {
  ratings: '評価した曲',
  watchLater: '後で聴く',
  history: '履歴',
  soundMap: '曲調マップ',
  chorus: 'サビ発掘',
  favoriteProducers: 'フォロー中',
  knowledgeMap: '網羅率',
  reports: 'レポート',
};
const name = (item: Playlist) => item.name;

describe('music Home quick tiles', () => {
  it('always shows eight tiles, filling with destinations when there are no playlists', () => {
    const tiles = buildQuickTiles([], [], labels, name);
    expect(tiles).toHaveLength(QUICK_TILE_COUNT);
    expect(tiles.map(tile => tile.key)).toEqual([
      'ratings', 'watchLater', 'history', 'soundMap', 'chorus', 'favoriteProducers', 'knowledgeMap', 'reports',
    ]);
    expect(tiles.every(tile => !tile.playable)).toBe(true);
  });

  it('puts up to four playlists after 評価した曲 and 後で聴く, in the library order, playable when they have songs', () => {
    const watchLater = playlist(WATCH_LATER_ID);
    const lists = ['a', 'b', 'c', 'd', 'e'].map(id => playlist(id, id === 'b' ? [] : [song]));
    const tiles = buildQuickTiles([watchLater, ...lists], [watchLater, ...lists], labels, name);
    expect(tiles.map(tile => tile.key)).toEqual([
      'ratings', 'watchLater', 'playlist:a', 'playlist:b', 'playlist:c', 'playlist:d', 'history', 'soundMap',
    ]);
    expect(tiles.find(tile => tile.key === 'watchLater')).toMatchObject({ playlist: watchLater, playable: true });
    expect(tiles.find(tile => tile.key === 'playlist:b')).toMatchObject({ playable: false, label: 'List b' });
    expect(tiles.find(tile => tile.key === 'playlist:a')).toMatchObject({ to: '/playlists?list=a', playable: true });
  });

  it('does not offer ▶ for an empty 後で聴く', () => {
    const tiles = buildQuickTiles([playlist(WATCH_LATER_ID, [])], [], labels, name);
    expect(tiles[1]).toMatchObject({ key: 'watchLater', playable: false, destination: 'watchLater' });
  });
});

describe('music Home greeting', () => {
  it('greets by the hour', () => {
    expect([4, 5, 10, 11, 17, 18, 23, 0].map(greetingFor)).toEqual([
      'evening', 'morning', 'morning', 'day', 'day', 'evening', 'evening', 'evening',
    ]);
  });
});
