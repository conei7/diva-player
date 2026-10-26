import { afterEach, describe, expect, it, vi } from 'vitest';
import { searchSmartPlaylistSongs } from './smartPlaylist';

describe('whole smart playlists', () => {
  afterEach(() => vi.unstubAllGlobals());
  const rule = { minYoutubeViews: 0, minNicoViews: 1000000, excludedSongTypes: [], maxSongs: 'all' as const };
  it('loads 990 songs in sequential bounded pages without fetching details', async () => {
    const starts: number[] = [];
    let active = 0;
    const fetchMock = vi.fn(async (url: string) => {
      expect(++active).toBe(1);
      const params = new URL(url, 'https://test.invalid').searchParams;
      const start = Number(params.get('start'));
      const size = Number(params.get('maxResults'));
      starts.push(start);
      expect(size).toBeLessThanOrEqual(100);
      expect(params.get('minNicoViews')).toBe('1000000');
      expect(params.get('compact')).toBe('true');
      if (size === 100) expect(params.get('sort')).toBe('AdditionDate');
      active--;
      return { ok: true, json: async () => ({ totalCount: 990, items: Array.from({ length: Math.min(size, 990 - start) }, (_, i) => ({ id: start + i + 1, name: `song ${start + i}` })) }) };
    });
    vi.stubGlobal('fetch', fetchMock);
    const result = await searchSmartPlaylistSongs(rule);
    expect(starts).toEqual([0, 100, 200, 300, 400, 500, 600, 700, 800, 900]);
    expect(result.items).toHaveLength(990);
    expect(new Set(result.items.map(song => song.id)).size).toBe(990);
    expect((await searchSmartPlaylistSongs(rule, 5)).items).toHaveLength(5);
    expect((await searchSmartPlaylistSongs({ ...rule, maxSongs: 50 })).items).toHaveLength(50);
  });
  it('cancels before requesting the next page', async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => {
      controller.abort();
      return { totalCount: 990, items: [{ id: 1 }] };
    } });
    vi.stubGlobal('fetch', fetchMock);
    await expect(searchSmartPlaylistSongs(rule, undefined, controller.signal)).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('rejects a failed later page instead of returning a partial list', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ totalCount: 990, items: [{ id: 1, name: 'first' }] }) })
      .mockResolvedValue({ ok: false, status: 503 });
    vi.stubGlobal('fetch', fetchMock);
    await expect(searchSmartPlaylistSongs(rule)).rejects.toThrow('503');
  });
  it('rejects counts outside the API offset contract and stops on empty pages', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ totalCount: 100001, items: [] }) }));
    await expect(searchSmartPlaylistSongs(rule)).rejects.toThrow('100000');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ totalCount: 990, items: [] }) }));
    await expect(searchSmartPlaylistSongs(rule)).rejects.toThrow('Incomplete');
  });
});


describe('stable whole-playlist sorting', () => {
  afterEach(() => vi.unstubAllGlobals());
  it.each(['FavoritedTimes', 'YoutubeViews', 'NicoViews', 'PublishDate'] as const)('collects tied pages by unique ID before sorting by %s', async (sortBy) => {
    const fetchMock = vi.fn(async (url: string) => {
      const params = new URL(url, 'https://test.invalid').searchParams;
      expect(params.get('sort')).toBe('AdditionDate');
      const start = Number(params.get('start'));
      return { ok: true, json: async () => ({ totalCount: 205, items: Array.from({ length: Math.min(100, 205 - start) }, (_, i) => {
        const id = 205 - start - i;
        return { id, favoritedTimes: id % 2, youtubeViews: id % 2, nicoViews: id % 2, publishDate: id % 2 ? '2025-01-01' : '2024-01-01' };
      }) }) };
    });
    vi.stubGlobal('fetch', fetchMock);
    const { items } = await searchSmartPlaylistSongs({ minYoutubeViews: 0, minNicoViews: 0, excludedSongTypes: [], maxSongs: 'all', sortBy });
    expect(items).toHaveLength(205);
    expect(new Set(items.map(song => song.id)).size).toBe(205);
    expect(items.slice(0, 103).every(song => song.id % 2 === 1)).toBe(true);
    expect(items[0].id).toBe(205);
    expect(items.at(-1)?.id).toBe(2);
  });
  it('keeps a 200-song capped list in one full-payload request to respect compact card capacity', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const params = new URL(url, 'https://test.invalid').searchParams;
      expect(params.get('maxResults')).toBe('200');
      expect(params.get('compact')).toBeNull();
      expect(params.get('sort')).toBe('NicoViews');
      return { ok: true, json: async () => ({ totalCount: 990, items: Array.from({ length: 200 }, (_, id) => ({ id })) }) };
    });
    vi.stubGlobal('fetch', fetchMock);
    expect((await searchSmartPlaylistSongs({ minYoutubeViews: 0, minNicoViews: 1000000, excludedSongTypes: [], maxSongs: 200, sortBy: 'NicoViews' })).items).toHaveLength(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
