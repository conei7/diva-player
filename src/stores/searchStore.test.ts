import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ADVANCED_SEARCH_LIMITS,
  DEFAULT_ADVANCED_FILTERS,
  sanitizeAdvancedIntegerInput,
  searchSongsBackend,
  validateAdvancedSearchFilters,
} from './searchStore';

describe('advanced search input limits', () => {
  it('rejects values outside the database-safe ranges', () => {
    expect(validateAdvancedSearchFilters({
      ...DEFAULT_ADVANCED_FILTERS,
      publishYearFrom: '0',
    })).toContain('投稿年');
    expect(validateAdvancedSearchFilters({
      ...DEFAULT_ADVANCED_FILTERS,
      publishYearTo: '5874897',
    })).toContain('投稿年');
    expect(validateAdvancedSearchFilters({
      ...DEFAULT_ADVANCED_FILTERS,
      lengthMinSeconds: '-1',
    })).toContain('曲の長さ');
    expect(validateAdvancedSearchFilters({
      ...DEFAULT_ADVANCED_FILTERS,
      lengthMaxSeconds: '2147483648',
    })).toContain('曲の長さ');
  });

  it('accepts the inclusive boundary values', () => {
    expect(validateAdvancedSearchFilters({
      ...DEFAULT_ADVANCED_FILTERS,
      publishYearFrom: String(ADVANCED_SEARCH_LIMITS.publishYearMin),
      publishYearTo: String(ADVANCED_SEARCH_LIMITS.publishYearMax),
      lengthMinSeconds: String(ADVANCED_SEARCH_LIMITS.lengthMinSeconds),
      lengthMaxSeconds: String(ADVANCED_SEARCH_LIMITS.lengthMaxSeconds),
    })).toBeNull();
  });

  it('clears negative input and caps oversized input before it reaches the API', () => {
    expect(sanitizeAdvancedIntegerInput('-10', 0, 100)).toBe('');
    expect(sanitizeAdvancedIntegerInput('101', 0, 100)).toBe('100');
    expect(sanitizeAdvancedIntegerInput('', 0, 100)).toBe('');
  });
});

describe('backend artist union search', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends singer variants as anyArtistIds while keeping required artists separate', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ items: [], totalCount: 1608 }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await searchSongsBackend({
      artistIds: [999],
      anyArtistIds: [58538, 98107, 106655],
      songTypes: ['Original'],
      sort: 'YoutubeViews',
      sortOrder: 'desc',
      start: 24,
      maxResults: 24,
    });

    const url = new URL(String(fetchMock.mock.calls[0]?.[0]), 'https://example.test');
    expect(url.searchParams.get('artistIds')).toBe('999');
    expect(url.searchParams.get('anyArtistIds')).toBe('58538,98107,106655');
    expect(url.searchParams.get('songTypes')).toBe('Original');
    expect(url.searchParams.get('start')).toBe('24');
    expect(result.totalCount).toBe(1608);
  });

  it('encodes each logical singer group as an independent OR condition', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ items: [], totalCount: 0 }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await searchSongsBackend({
      artistIdGroups: [[58538, 98107], [1, 2]],
      sort: 'FavoritedTimes',
      sortOrder: 'desc',
      start: 0,
      maxResults: 24,
    });

    const url = new URL(String(fetchMock.mock.calls[0]?.[0]), 'https://example.test');
    expect(url.searchParams.get('artistIdGroups')).toBe('58538,98107|1,2');
  });
});
