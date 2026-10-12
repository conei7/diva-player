import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Artist, Song } from '../types/vocadb';

const api = vi.hoisted(() => ({
  findArtistByName: vi.fn<(query: string) => Promise<Artist | null>>(),
  resolveProducerByName: vi.fn<(query: string) => Promise<Artist | null>>(),
  searchVocalistsByName: vi.fn<(query: string, maxResults?: number) => Promise<Artist[]>>(),
  searchSongs: vi.fn(),
}));

const backend = vi.hoisted(() => ({
  searchSongsBackend: vi.fn<(params: Record<string, unknown>) => Promise<{ items: Song[]; totalCount: number }>>(),
}));

vi.mock('../api/vocadb', async importOriginal => ({
  ...(await importOriginal<typeof import('../api/vocadb')>()),
  findArtistByName: api.findArtistByName,
  resolveProducerByName: api.resolveProducerByName,
  searchVocalistsByName: api.searchVocalistsByName,
  searchSongs: api.searchSongs,
}));

vi.mock('../search/searchBackendClient', async importOriginal => ({
  ...(await importOriginal<typeof import('../search/searchBackendClient')>()),
  searchSongsBackend: backend.searchSongsBackend,
}));

const { textSearchKey, artistSearchKey, useSearchStore } = await import('./searchStore');
const {
  ADVANCED_SEARCH_UNAVAILABLE_ERROR,
  DEFAULT_ADVANCED_FILTERS,
  SEARCH_FAILED_ERROR,
  getAdvancedRangeErrors,
  getSearchErrorMessage,
} = await import('../search/searchModel');

const song = (id: number, name: string) => ({ id, name, defaultName: name } as Song);
const artist = (id: number, name: string, artistType: Artist['artistType'] = 'Producer'): Artist => ({ id, name, artistType });

describe('URL-driven search modes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSearchStore.getState().reset();
    api.findArtistByName.mockResolvedValue(null);
    api.resolveProducerByName.mockResolvedValue(null);
    api.searchVocalistsByName.mockResolvedValue([]);
    backend.searchSongsBackend.mockImplementation(async params => (
      Array.isArray(params.artistIds)
        ? { items: [song(200, 'Producer song')], totalCount: 61 }
        : { items: [song(100, 'Title song')], totalCount: 201 }
    ));
  });

  it('searches titles only for 曲名 and keeps doing so after the sort changes', async () => {
    await useSearchStore.getState().searchWithMode(' シャルル ', 'song', 'key-1');

    let state = useSearchStore.getState();
    expect(state.searchType).toBe('song');
    expect(state.searchOrigin).toBe('url');
    expect(state.urlSearchKey).toBe(textSearchKey('シャルル', 'song'));
    expect(state.urlSearchLocationKey).toBe('key-1');
    expect(state.results.map(item => item.id)).toEqual([100]);
    expect(backend.searchSongsBackend).toHaveBeenLastCalledWith(expect.objectContaining({ query: 'シャルル' }));

    useSearchStore.getState().setSort('PublishDate');
    await useSearchStore.getState().search();

    state = useSearchStore.getState();
    expect(api.findArtistByName).not.toHaveBeenCalled();
    expect(state.searchType).toBe('song');
    expect(state.urlSearchKey).toBe(textSearchKey('シャルル', 'song'));
  });

  it('resolves the producer for ボカロP and remembers it for the producer header', async () => {
    api.resolveProducerByName.mockResolvedValue(artist(5, 'wowaka'));

    await useSearchStore.getState().searchWithMode('wowaka', 'producer');

    const state = useSearchStore.getState();
    expect(state.resolvedArtistId).toBe(5);
    expect(state.resolvedArtist).toEqual({ id: 5, name: 'wowaka', artistType: 'Producer' });
    expect(state.totalCount).toBe(61);
    expect(state.searchOrigin).toBe('url');
    expect(state.urlSearchKey).toBe(textSearchKey('wowaka', 'producer'));
  });

  it('falls back to a title search when no producer matches the name', async () => {
    await useSearchStore.getState().searchWithMode('存在しないP', 'producer');

    const state = useSearchStore.getState();
    expect(state.resolvedArtistId).toBeNull();
    expect(state.resolvedArtist).toBeNull();
    expect(state.results.map(item => item.id)).toEqual([100]);
    expect(backend.searchSongsBackend).toHaveBeenLastCalledWith(expect.objectContaining({ query: '存在しないP' }));
  });

  it('combines every voicebank of a vocalist with Any and drops them when the mode changes', async () => {
    api.searchVocalistsByName.mockResolvedValue([
      artist(1, '初音ミク', 'Vocaloid'),
      artist(2, '初音ミク V3 (Solid)', 'Vocaloid'),
      artist(3, '初音ミクオリジナル', 'Vocaloid'),
    ]);

    await useSearchStore.getState().searchWithMode('初音ミク', 'vocalist');

    let state = useSearchStore.getState();
    expect(state.query).toBe('');
    expect(state.vocalistFilters.map(filter => filter.id)).toEqual([1, 2]);
    expect(state.vocalistFilters.every(filter => filter.variantGroup === '初音ミク')).toBe(true);
    expect(state.vocalistMatchMode).toBe('Any');
    expect(state.modeVocalistIds).toEqual([1, 2]);

    // The mode's own vocalists are the query: clearing the conditions keeps them.
    useSearchStore.getState().setVocalistFilters([...state.vocalistFilters, { id: 9, name: '重音テト' }]);
    useSearchStore.getState().clearSearchConditions();
    expect(useSearchStore.getState().vocalistFilters.map(filter => filter.id)).toEqual([1, 2]);

    await useSearchStore.getState().searchWithMode('初音ミク', 'all');
    state = useSearchStore.getState();
    expect(state.query).toBe('初音ミク');
    expect(state.vocalistFilters).toEqual([]);
    expect(state.modeVocalistIds).toEqual([]);
  });

  it('shows the producer for すべて when the words name a producer and no title matches exactly', async () => {
    api.findArtistByName.mockResolvedValue(artist(9, 'ハチ'));

    await useSearchStore.getState().searchWithMode('ハチ');

    const state = useSearchStore.getState();
    expect(state.resolvedArtist).toEqual({ id: 9, name: 'ハチ', artistType: 'Producer' });
    expect(state.results.map(item => item.id)).toEqual([200]);
  });

  it('keys artist pages by id and role', async () => {
    await useSearchStore.getState().searchArtistFromUrl(42, 'Illustrator name', 'Illustrator', 'key-2');

    const state = useSearchStore.getState();
    expect(state.urlSearchKey).toBe(artistSearchKey(42, 'Illustrator'));
    expect(state.artistRole).toBe('Illustrator');
    expect(state.resolvedArtist).toEqual({ id: 42, name: 'Illustrator name' });
    expect(backend.searchSongsBackend).toHaveBeenLastCalledWith(expect.objectContaining({ artistIds: [42], artistRole: 'Illustrator' }));
  });

  it('keeps a URL search URL-driven when the dialog applies, and marks query-less searches as advanced', async () => {
    await useSearchStore.getState().searchWithMode('シャルル');
    await useSearchStore.getState().applyAdvancedSearch();
    expect(useSearchStore.getState().searchOrigin).toBe('url');

    useSearchStore.getState().reset();
    useSearchStore.getState().setAdvancedFilters({ lyricsQuery: '夜' });
    await useSearchStore.getState().applyAdvancedSearch();
    expect(useSearchStore.getState().searchOrigin).toBe('advanced');
    expect(useSearchStore.getState().urlSearchKey).toBeNull();
  });

  it('says 検索できませんでした for a failed keyword search, although its default sort goes through the backend', async () => {
    backend.searchSongsBackend.mockRejectedValue(new Error('HTTP 503'));

    await useSearchStore.getState().searchWithMode('ハチ');

    expect(useSearchStore.getState().sort).toBe('TotalViews');
    expect(useSearchStore.getState().error).toBe(SEARCH_FAILED_ERROR);
  });

  it('says いまは詳細検索を使えません only when advanced-search conditions were used', async () => {
    backend.searchSongsBackend.mockRejectedValue(new Error('HTTP 503'));

    useSearchStore.getState().setAdvancedFilters({ lyricsQuery: '夜' });
    await useSearchStore.getState().applyAdvancedSearch();
    expect(useSearchStore.getState().error).toBe(ADVANCED_SEARCH_UNAVAILABLE_ERROR);

    useSearchStore.getState().reset();
    await useSearchStore.getState().searchArtistFromUrl(42, 'Illustrator name', 'Illustrator', 'key-3');
    expect(useSearchStore.getState().error).toBe(ADVANCED_SEARCH_UNAVAILABLE_ERROR);

    useSearchStore.getState().reset();
    await useSearchStore.getState().searchArtistFromUrl(42, 'Producer name', undefined, 'key-4');
    expect(useSearchStore.getState().error).toBe(SEARCH_FAILED_ERROR);
  });

  it('treats store calls from outside the URL flow as direct searches', () => {
    useSearchStore.getState().setQuery('old flow');
    expect(useSearchStore.getState().searchOrigin).toBe('direct');
    expect(useSearchStore.getState().urlSearchKey).toBeNull();

    useSearchStore.getState().reset();
    expect(useSearchStore.getState().searchOrigin).toBeNull();
    expect(useSearchStore.getState().searchType).toBe('all');
  });
});

describe('search model messages and ranges', () => {
  it('never shows internal causes', () => {
    expect(getSearchErrorMessage(new Error('HTTP 503 from SBC'), true)).toBe(ADVANCED_SEARCH_UNAVAILABLE_ERROR);
    expect(getSearchErrorMessage(new Error('HTTP 500'), false)).toBe(SEARCH_FAILED_ERROR);
  });

  it('reports range errors per field', () => {
    expect(getAdvancedRangeErrors({ ...DEFAULT_ADVANCED_FILTERS, bpmFrom: '180', bpmTo: '90' })).toEqual({ bpm: 'order' });
    expect(getAdvancedRangeErrors({ ...DEFAULT_ADVANCED_FILTERS, bpmFrom: '10' })).toEqual({ bpm: 'bounds' });
    expect(getAdvancedRangeErrors({ ...DEFAULT_ADVANCED_FILTERS, publishYearFrom: '2007', publishYearTo: '2012' })).toEqual({});
  });
});
