import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ADVANCED_SEARCH_LIMITS,
  DEFAULT_ADVANCED_FILTERS,
  applyLocalSort,
  hasExactSongTitleMatch,
  sanitizeAdvancedIntegerInput,
  useSearchStore,
  searchSongsBackend,
  validateAdvancedSearchFilters,
} from './searchStore';

const titleSong = (name: string, defaultName = name) => ({
  id: 1,
  name,
  defaultName,
} as Parameters<typeof hasExactSongTitleMatch>[0][number]);

describe('search result sorting', () => {
  it('defaults to weighted total views', () => {
    useSearchStore.getState().reset();
    expect(useSearchStore.getState().sort).toBe('TotalViews');
  });

  it('keeps the API order for weighted total views', () => {
    const songs = [
      { id: 1, youtubeViews: 0, nicoViews: 50 },
      { id: 2, youtubeViews: 100, nicoViews: 0 },
    ] as Parameters<typeof applyLocalSort>[0];

    expect(applyLocalSort(songs, 'TotalViews', 'desc').map(song => song.id)).toEqual([1, 2]);
  });
});

describe('automatic song-or-producer resolution', () => {
  it('prefers a normalized exact song title over an inferred producer', () => {
    expect(hasExactSongTitleMatch([titleSong('シャルル')], ' シャルル ')).toBe(true);
    expect(hasExactSongTitleMatch([titleSong('ＳＴＡＲ')], 'STAR')).toBe(true);
  });

  it('keeps producer resolution when title results are only partial matches', () => {
    expect(hasExactSongTitleMatch([titleSong('シャルル -jazz arrange-')], 'シャルル')).toBe(false);
    expect(hasExactSongTitleMatch([titleSong('ENDLESS PARADE')], 'シャルル')).toBe(false);
  });

  it('also recognizes the canonical default title', () => {
    expect(hasExactSongTitleMatch([titleSong('Charles', 'シャルル')], 'シャルル')).toBe(true);
  });
});

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

  it('encodes a credit role together with an artist id', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ items: [], totalCount: 0 }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await searchSongsBackend({
      artistIds: [123],
      artistRole: 'Illustrator',
      sort: 'FavoritedTimes',
      sortOrder: 'desc',
      start: 0,
      maxResults: 24,
    });

    const url = new URL(String(fetchMock.mock.calls[0]?.[0]), 'https://example.test');
    expect(url.searchParams.get('artistIds')).toBe('123');
    expect(url.searchParams.get('artistRole')).toBe('Illustrator');
  });

  it('encodes price-comparison style facets and stable random ordering', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      headers: { get: () => null },
      json: async () => ({ items: [], totalCount: 321 }),
    });
    vi.stubGlobal('fetch', fetchMock);
    useSearchStore.getState().setSort('Random');

    await searchSongsBackend({
      query: 'advanced-facet-contract',
      songTypes: ['Original', 'Remix'],
      sort: 'Random',
      sortOrder: 'desc',
      start: 0,
      maxResults: 24,
      filters: {
        ...DEFAULT_ADVANCED_FILTERS,
        minYoutubeViews: '1000',
        maxYoutubeViews: '9000',
        minNicoViews: '100',
        maxNicoViews: '900',
        minFavoritedTimes: '5',
        maxFavoritedTimes: '50',
        tagFilters: [{ id: 337, name: 'ピアノ' }, { id: 481, name: 'ロック' }],
        tagMatchMode: 'all',
        creditArtist: { id: 777, name: '絵師' },
        creditRole: 'Illustrator',
      },
    });

    const url = new URL(String(fetchMock.mock.calls[0]?.[0]), 'https://example.test');
    expect(url.searchParams.get('songTypes')).toBe('Original,Remix');
    expect(url.searchParams.get('minYoutubeViews')).toBe('1000');
    expect(url.searchParams.get('maxYoutubeViews')).toBe('9000');
    expect(url.searchParams.get('minNicoViews')).toBe('100');
    expect(url.searchParams.get('maxNicoViews')).toBe('900');
    expect(url.searchParams.get('minFavoritedTimes')).toBe('5');
    expect(url.searchParams.get('maxFavoritedTimes')).toBe('50');
    expect(url.searchParams.get('tagIds')).toBe('337,481');
    expect(url.searchParams.get('tagMatchMode')).toBe('all');
    expect(url.searchParams.get('creditArtistId')).toBe('777');
    expect(url.searchParams.get('creditArtistRole')).toBe('Illustrator');
    expect(Number(url.searchParams.get('randomSeed'))).toBeGreaterThanOrEqual(0);
    useSearchStore.getState().reset();
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
    expect(url.searchParams.get('onlyWithPVs')).toBe('true');
    expect(url.searchParams.get('discoveryOnly')).toBeNull();
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

  it('requests the reusable quality boundary only for discovery surfaces', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      headers: { get: () => null },
      json: async () => ({ items: [], totalCount: 0 }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await searchSongsBackend({
      query: 'discovery-boundary-test',
      sort: 'FavoritedTimes',
      sortOrder: 'desc',
      start: 0,
      maxResults: 24,
      discoveryOnly: true,
    });

    const url = new URL(String(fetchMock.mock.calls[0]?.[0]), 'https://example.test');
    expect(url.searchParams.get('discoveryOnly')).toBe('true');
  });

  it('reuses identical backend searches for one minute', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      headers: { get: () => null },
      json: async () => ({ items: [], totalCount: 12 }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const params = {
      query: 'cache-contract-search',
      sort: 'FavoritedTimes' as const,
      sortOrder: 'desc' as const,
      start: 0,
      maxResults: 24,
    };

    await searchSongsBackend(params);
    await searchSongsBackend(params);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('direct artist search state', () => {
  it('clears the resolved artist when the user starts a new text query', () => {
    useSearchStore.setState({ resolvedArtistId: 123, query: 'old artist' });

    useSearchStore.getState().setQuery('new query');

    expect(useSearchStore.getState().resolvedArtistId).toBeNull();
    expect(useSearchStore.getState().query).toBe('new query');
    useSearchStore.getState().reset();
  });
});
