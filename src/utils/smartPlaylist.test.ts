import { describe, expect, it } from 'vitest';
import type { SmartPlaylistRule } from '../types/vocadb';
import { formatSmartPlaylistRule, SMART_DERIVED_SONG_TYPES } from './smartPlaylist';

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
});
