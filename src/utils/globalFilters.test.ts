import { describe, expect, it } from 'vitest';
import type { Song } from '../types/vocadb';
import { DEFAULT_GLOBAL_FILTER_SETTINGS, normalizeGlobalFilterSettings, type GlobalFilterSettings } from '../stores/globalFilterStore';
import {
  applyDiscoveryFilter,
  applyDiscoveryFilterWithRelaxation,
  applyGlobalSongFilter,
  areGlobalFilterSettingsEqual,
  formatCooldownDuration,
  getGlobalFilterSummary,
  getDiscoveryRelaxationMessage,
  getDiscoveryRelaxationShortLabel,
  getGlobalSongFilterDecision,
  filterDiscoverySourcePage,
  hasConfiguredSongFilters,
  isDiscoveryFilterActive,
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

function vocalist(id: number, name = `vocalist-${id}`): NonNullable<Song['artists']>[number] {
  return {
    id,
    name,
    categories: 'Vocalist',
    effectiveRoles: 'Default',
    isCustomName: false,
    isSupport: false,
    roles: 'Default',
    artist: {
      id,
      name,
      additionalNames: '',
      artistType: 'Vocaloid',
      deleted: false,
      status: 'Finished',
      version: 1,
    },
  };
}

describe('global filters', () => {
  it('migrates legacy settings and rejects invalid vocalist entries', () => {
    expect(normalizeGlobalFilterSettings({ enabled: true, minYoutubeViews: 100 })).toMatchObject({
      enabled: true,
      minYoutubeViews: 100,
      vocalistFilters: [],
      vocalistMatchMode: 'Any',
    });
    expect(normalizeGlobalFilterSettings({
      vocalistFilters: [{ id: 39, name: '初音ミク' }, { id: -1, name: 'invalid' }, { id: 39, name: 'duplicate' }],
      vocalistMatchMode: 'Exact',
    }).vocalistFilters).toEqual([{ id: 39, name: '初音ミク' }]);
  });

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

  it('excludes self-covers when asked, whatever their song type', () => {
    const settings = { ...DEFAULT_GLOBAL_FILTER_SETTINGS, enabled: true, excludeSelfCovers: true };
    expect(matchesGlobalSongFilter(song({ songType: 'Cover', isSelfCover: true }), settings)).toBe(false);
    expect(matchesGlobalSongFilter(song({ songType: 'Cover' }), settings)).toBe(true);
    expect(matchesGlobalSongFilter(song({ isSelfCover: true }), { ...settings, enabled: false })).toBe(true);
    expect(hasConfiguredSongFilters({ ...DEFAULT_GLOBAL_FILTER_SETTINGS, excludeSelfCovers: true })).toBe(true);
    expect(normalizeGlobalFilterSettings({ excludeSelfCovers: 'yes' }).excludeSelfCovers).toBe(false);
    expect(areGlobalFilterSettingsEqual(settings, { ...settings, excludeSelfCovers: false })).toBe(false);
  });

  it('applies global vocalist Any, All, grouped variants, and Exact matching', () => {
    const filters = [
      { id: 10, name: 'Miku V2', variantGroup: '初音ミク' },
      { id: 11, name: 'Miku NT', variantGroup: '初音ミク' },
      { id: 20, name: 'Teto' },
    ];
    const base = { ...DEFAULT_GLOBAL_FILTER_SETTINGS, enabled: true, vocalistFilters: filters };
    expect(matchesGlobalSongFilter(song({ artists: [vocalist(11)] }), { ...base, vocalistMatchMode: 'Any' })).toBe(true);
    expect(matchesGlobalSongFilter(song({ artists: [vocalist(11)] }), { ...base, vocalistMatchMode: 'All' })).toBe(false);
    expect(matchesGlobalSongFilter(song({ artists: [vocalist(11), vocalist(20)] }), { ...base, vocalistMatchMode: 'All' })).toBe(true);
    expect(matchesGlobalSongFilter(song({ artists: [vocalist(11), vocalist(20), vocalist(30)] }), { ...base, vocalistMatchMode: 'Exact' })).toBe(false);
    expect(getGlobalSongFilterDecision(song({ artists: [vocalist(30)] }), base)).toEqual({ accepted: false, reason: 'excluded-vocalist' });
  });

  it('reports configured and active states separately', () => {
    const configured = { ...DEFAULT_GLOBAL_FILTER_SETTINGS, excludedSongTypes: ['Cover' as const] };
    expect(hasConfiguredSongFilters(configured)).toBe(true);
    expect(isGlobalSongFilterActive(configured)).toBe(false);
    expect(isGlobalSongFilterActive({ ...configured, enabled: true })).toBe(true);
    expect(getGlobalFilterSummary({ ...configured, enabled: true })).toEqual(['カバーを除外']);
    expect(isDiscoveryFilterActive({ ...DEFAULT_GLOBAL_FILTER_SETTINGS, cooldownHours: 24 })).toBe(true);
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

  it('does not relax a full source page while later pages may still contain strict matches', () => {
    const context = {
      settings: { ...DEFAULT_GLOBAL_FILTER_SETTINGS, enabled: true, minYoutubeViews: 1_000 },
    };
    const candidates = [song({ id: 1, youtubeViews: 100 }), song({ id: 2, youtubeViews: 1_000 })];
    expect(filterDiscoverySourcePage(candidates, context, 2, false)).toEqual({
      items: [candidates[1]],
      relaxedConditions: [],
    });
    expect(filterDiscoverySourcePage(candidates, context, 2, true).items).toHaveLength(2);
  });
});

describe('filter summaries', () => {
  const configured: GlobalFilterSettings = {
    ...DEFAULT_GLOBAL_FILTER_SETTINGS,
    enabled: true,
    minYoutubeViews: 10_000,
    excludedSongTypes: ['Cover', 'Remix'],
    cooldownHours: 24,
    excludeRatedFromDiscovery: true,
  };

  it('summarizes the filters in Japanese and English', () => {
    expect(getGlobalFilterSummary(configured)).toEqual([
      'YouTube 10,000以上',
      'カバー・リミックスを除外',
      '最近聴いた曲を除く（24時間）',
      '評価した曲を除く',
    ]);
    expect(getGlobalFilterSummary(configured, 'en')).toEqual([
      'YouTube ≥ 10,000 views',
      'Cover, Remix excluded',
      'Skip recently played (1 day)',
      'Skip rated songs',
    ]);
  });

  it('lists self-covers after the excluded song types', () => {
    const selfCovers = { ...DEFAULT_GLOBAL_FILTER_SETTINGS, enabled: true, excludedSongTypes: ['Remix' as const], excludeSelfCovers: true };
    expect(getGlobalFilterSummary(selfCovers)).toEqual(['リミックス・セルフカバーを除外']);
    expect(getGlobalFilterSummary(selfCovers, 'en')).toEqual(['Remix, Self-cover excluded']);
  });

  it('names song types the same way as the settings chips', () => {
    const musicVideos = { ...DEFAULT_GLOBAL_FILTER_SETTINGS, enabled: true, excludedSongTypes: ['MusicPV' as const] };
    expect(getGlobalFilterSummary(musicVideos)).toEqual(['PVを除外']);
    expect(getGlobalFilterSummary(musicVideos, 'en')).toEqual(['Music video excluded']);
  });

  it('adds the match mode only when two or more vocalists are chosen', () => {
    const one = { ...DEFAULT_GLOBAL_FILTER_SETTINGS, enabled: true, vocalistFilters: [{ id: 1, name: '初音ミク' }] };
    expect(getGlobalFilterSummary(one)).toEqual(['ボーカル: 初音ミク']);
    expect(getGlobalFilterSummary(one, 'en')).toEqual(['Vocalist: 初音ミク']);

    const two: GlobalFilterSettings = {
      ...one,
      vocalistMatchMode: 'All',
      vocalistFilters: [
        { id: 1, name: 'Miku V2', variantGroup: '初音ミク' },
        { id: 2, name: 'Miku NT', variantGroup: '初音ミク' },
        { id: 3, name: '重音テト' },
      ],
    };
    expect(getGlobalFilterSummary(two)).toEqual(['ボーカル: 初音ミク・重音テト（すべて含む）']);
    expect(getGlobalFilterSummary(two, 'en')).toEqual(['Vocalists: 初音ミク, 重音テト (All of these)']);
  });

  it('formats cooldown lengths as hours or days', () => {
    expect(formatCooldownDuration(1)).toBe('1時間');
    expect(formatCooldownDuration(24)).toBe('24時間');
    expect(formatCooldownDuration(72)).toBe('3日');
    expect(formatCooldownDuration(168)).toBe('7日');
    expect(formatCooldownDuration(1, 'en')).toBe('1 hour');
    expect(formatCooldownDuration(6, 'en')).toBe('6 hours');
    expect(formatCooldownDuration(24, 'en')).toBe('1 day');
    expect(formatCooldownDuration(72, 'en')).toBe('3 days');
  });

  it('describes relaxed discovery conditions in both languages', () => {
    expect(getDiscoveryRelaxationMessage([])).toBeNull();
    expect(getDiscoveryRelaxationMessage(['cooldown', 'view-thresholds-removed'])).toContain('最近再生した曲');
    const english = getDiscoveryRelaxationMessage(['cooldown', 'rated-songs'], 'en');
    expect(english).toContain('recently played songs');
    expect(english).toContain('rated songs');
    expect(getDiscoveryRelaxationShortLabel()).toBe('一部の条件をゆるめて表示しています');
    expect(getDiscoveryRelaxationShortLabel('en')).toBe('Some filters were relaxed');
  });
});
