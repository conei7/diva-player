import { describe, expect, it } from 'vitest';
import type { SmartPlaylistRule, Song } from '../types/vocadb';
import {
  buildSmartPlaylistSearchParams,
  filterSmartPlaylistSongs,
  formatSmartPlaylistRule,
  SMART_DERIVED_SONG_TYPES,
} from './smartPlaylist';

const rule = (overrides: Partial<SmartPlaylistRule> = {}): SmartPlaylistRule => ({
  minYoutubeViews: 0,
  minNicoViews: 0,
  excludedSongTypes: [],
  ...overrides,
});

describe('smart playlist UI summaries', () => {
  it('shows a useful empty condition summary', () => {
    expect(formatSmartPlaylistRule(rule())).toEqual(['条件なし']);
  });

  it('formats thresholds, producer and exclusions for the builder and header', () => {
    expect(formatSmartPlaylistRule(rule({
      producerName: 'テストP',
      minYoutubeViews: 100000,
      minNicoViews: 5000,
      excludedSongTypes: SMART_DERIVED_SONG_TYPES,
    }))).toEqual([
      'P: テストP',
      'YouTube 100,000以上',
      'ニコニコ 5,000以上',
      '除外: カバー・リミックス・アレンジ・マッシュアップ',
    ]);
  });

  it('builds a database query that applies the saved conditions before pagination', () => {
    const params = buildSmartPlaylistSearchParams(rule({
      producerId: 39,
      minYoutubeViews: 100_000_000,
      excludedSongTypes: ['Cover'],
    }));

    expect(params.get('artistIds')).toBe('39');
    expect(params.get('minYoutubeViews')).toBe('100000000');
    expect(params.get('excludeSongTypes')).toBe('Cover');
    expect(params.get('sort')).toBe('YoutubeViews');
    expect(params.get('maxResults')).toBe('200');
  });

  it('never fills a smart playlist with songs outside its conditions', () => {
    const songs = [
      { id: 1, name: 'matched', songType: 'Original', youtubeViews: 100_000_000 },
      { id: 2, name: 'too low', songType: 'Original', youtubeViews: 99_999_999 },
      { id: 3, name: 'excluded', songType: 'Cover', youtubeViews: 200_000_000 },
    ] as Song[];

    expect(filterSmartPlaylistSongs(songs, rule({
      minYoutubeViews: 100_000_000,
      excludedSongTypes: ['Cover'],
    })).map(song => song.id)).toEqual([1]);
  });
});
