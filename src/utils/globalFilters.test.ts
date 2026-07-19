import { describe, expect, it } from 'vitest';
import type { Song } from '../types/vocadb';
import { DEFAULT_GLOBAL_FILTER_SETTINGS, type GlobalFilterSettings } from '../stores/globalFilterStore';
import {
  applyDiscoveryFilter,
  applyDiscoveryFilterWithRelaxation,
  applyGlobalSongFilter,
  areGlobalFilterSettingsEqual,
  getGlobalFilterSummary,
  getDiscoveryRelaxationMessage,
  getGlobalSongFilterDecision,
  hasConfiguredSongFilters,
  isGlobalSongFilterActive,
  isSongType,
  matchesGlobalSongFilter,
  requiresExternalViewCounts,
} from './globalFilters';

function song(overrides: Partial<Song> = {}): Song {
  return {
    id: 1,
    name: 'test',
    defaultName: 'test',
    defaultNameLanguage: 'Unspecified',
    artistString: 'artist',
    createDate: '2026-01-01',
    favoritedTimes: 0,
    lengthSeconds: 180,
    pvServices: 'Youtube',
    ratingScore: 0,
    songType: 'Original',
    status: 'Finished',
    version: 1,
    ...overrides,
  };
}

describe('global filters', () => {
  it('keeps all songs while disabled', () => {
    expect(applyGlobalSongFilter([song(), song({ id: 2, songType: 'Cover' })], DEFAULT_GLOBAL_FILTER_SETTINGS)).toHaveLength(2);
  });

  it('requires each enabled view threshold and rejects unknown values', () => {
    const settings = { ...DEFAULT_GLOBAL_FILTER_SETTINGS, enabled: true, minYoutubeViews: 100, minNicoViews: 50 };
    expect(matchesGlobalSongFilter(song({ youtubeViews: 100, nicoViews: 50 }), settings)).toBe(true);
    expect(matchesGlobalSongFilter(song({ youtubeViews: 99, nicoViews: 50 }), settings)).toBe(false);
    expect(matchesGlobalSongFilter(song({ youtubeViews: 100 }), settings)).toBe(false);
  });

  it('excludes selected song types', () => {
    const settings = { ...DEFAULT_GLOBAL_FILTER_SETTINGS, enabled: true, excludedSongTypes: ['Remix' as const] };
    expect(matchesGlobalSongFilter(song({ songType: 'Remix' }), settings)).toBe(false);
    expect(matchesGlobalSongFilter(song({ songType: 'Original' }), settings)).toBe(true);
  });

  it('reports configured and active states separately', () => {
    const configured = { ...DEFAULT_GLOBAL_FILTER_SETTINGS, excludedSongTypes: ['Cover' as const] };
    expect(hasConfiguredSongFilters(configured)).toBe(true);
    expect(isGlobalSongFilterActive(configured)).toBe(false);
    expect(isGlobalSongFilterActive({ ...configured, enabled: true })).toBe(true);
    expect(getGlobalFilterSummary({ ...configured, enabled: true })).toEqual(['カバーを除外']);
  });

  it('compares saved and draft settings without depending on song type order', () => {
    const first: GlobalFilterSettings = {
      ...DEFAULT_GLOBAL_FILTER_SETTINGS,
      enabled: true,
      excludedSongTypes: ['Cover', 'Remix'],
    };
    const second: GlobalFilterSettings = {
      ...DEFAULT_GLOBAL_FILTER_SETTINGS,
      enabled: true,
      excludedSongTypes: ['Remix', 'Cover'],
    };
    expect(areGlobalFilterSettingsEqual(first, second)).toBe(true);
    expect(areGlobalFilterSettingsEqual(first, { ...second, minYoutubeViews: 1 })).toBe(false);
  });

  it('returns a typed rejection reason for each view threshold', () => {
    const settings = { ...DEFAULT_GLOBAL_FILTER_SETTINGS, enabled: true, minYoutubeViews: 100, minNicoViews: 50 };
    expect(getGlobalSongFilterDecision(song(), settings)).toEqual({ accepted: false, reason: 'youtube-views-missing' });
    expect(getGlobalSongFilterDecision(song({ youtubeViews: 99, nicoViews: 100 }), settings)).toEqual({ accepted: false, reason: 'youtube-views-below-minimum' });
    expect(getGlobalSongFilterDecision(song({ youtubeViews: 100 }), settings)).toEqual({ accepted: false, reason: 'nico-views-missing' });
    expect(getGlobalSongFilterDecision(song({ youtubeViews: 100, nicoViews: 50 }), settings)).toEqual({ accepted: true });
  });

  it('requests external view counts only for active view thresholds', () => {
    expect(requiresExternalViewCounts(DEFAULT_GLOBAL_FILTER_SETTINGS)).toBe(false);
    expect(requiresExternalViewCounts({
      ...DEFAULT_GLOBAL_FILTER_SETTINGS,
      enabled: true,
      excludedSongTypes: ['Cover'],
    })).toBe(false);
    expect(requiresExternalViewCounts({
      ...DEFAULT_GLOBAL_FILTER_SETTINGS,
      enabled: true,
      minYoutubeViews: 1,
    })).toBe(true);
  });

  it('accepts only known VocaDB song types', () => {
    expect(isSongType('Cover')).toBe(true);
    expect(isSongType('Original')).toBe(true);
    expect(isSongType('UnknownType')).toBe(false);
  });

  it('applies rating and cooldown only to discovery candidates', () => {
    const settings = {
      ...DEFAULT_GLOBAL_FILTER_SETTINGS,
      enabled: true,
      excludeRatedFromDiscovery: true,
      cooldownHours: 24,
    };
    const now = 10_000_000;
    const songs = [song({ id: 1 }), song({ id: 2 }), song({ id: 3 })];
    const filtered = applyDiscoveryFilter(songs, {
      settings,
      ratings: { '1': 5 },
      lastPlayedAtBySongId: new Map([[2, now - 60 * 60 * 1000], [3, now - 25 * 60 * 60 * 1000]]),
      now,
    });
    expect(filtered.map(item => item.id)).toEqual([3]);
  });

  it('relaxes discovery conditions in order while preserving excluded song types', () => {
    const now = 10_000_000;
    const songs = [
      song({ id: 1, youtubeViews: 1_000 }),
      song({ id: 2, youtubeViews: 600 }),
      song({ id: 3, youtubeViews: 100 }),
      song({ id: 4, youtubeViews: 10_000, songType: 'Cover' }),
    ];
    const result = applyDiscoveryFilterWithRelaxation(songs, {
      settings: {
        ...DEFAULT_GLOBAL_FILTER_SETTINGS,
        enabled: true,
        minYoutubeViews: 1_000,
        excludedSongTypes: ['Cover'],
        cooldownHours: 24,
        excludeRatedFromDiscovery: true,
      },
      ratings: { '2': 5 },
      lastPlayedAtBySongId: new Map([[1, now - 1_000]]),
      now,
    }, 3);

    expect(result.items.map(item => item.id)).toEqual([1, 2, 3]);
    expect(result.relaxedConditions).toEqual([
      'cooldown',
      'rated-songs',
      'view-thresholds-removed',
    ]);
    expect(result.items.some(item => item.songType === 'Cover')).toBe(false);
  });

  it('stops at the first relaxation stage that supplies enough candidates', () => {
    const now = 10_000_000;
    const result = applyDiscoveryFilterWithRelaxation([
      song({ id: 1 }),
      song({ id: 2 }),
    ], {
      settings: {
        ...DEFAULT_GLOBAL_FILTER_SETTINGS,
        cooldownHours: 24,
        excludeRatedFromDiscovery: true,
      },
      ratings: { '2': 5 },
      lastPlayedAtBySongId: new Map([[1, now - 1_000]]),
      now,
    }, 1);

    expect(result.items.map(item => item.id)).toEqual([1]);
    expect(result.relaxedConditions).toEqual(['cooldown']);
    expect(getDiscoveryRelaxationMessage(result.relaxedConditions)).toContain('最近再生した曲');
  });

  it('does not report relaxation when no stage adds candidates', () => {
    const result = applyDiscoveryFilterWithRelaxation([
      song({ id: 1, songType: 'Cover' }),
    ], {
      settings: {
        ...DEFAULT_GLOBAL_FILTER_SETTINGS,
        enabled: true,
        excludedSongTypes: ['Cover'],
        cooldownHours: 24,
      },
    }, 1);
    expect(result).toEqual({ items: [], relaxedConditions: [] });
  });
});
