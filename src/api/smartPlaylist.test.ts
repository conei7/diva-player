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
      active--;
      return { ok: true, json: async () => ({ totalCount: 990, items: Array.from({ length: Math.min(size, 990 - start) }, (_, i) => ({ id: start + i + 1, name: `song ${start + i}` })) }) };
    });
    vi.stubGlobal('fetch', fetchMock);
    const result = await searchSmartPlaylistSongs(rule);
    expect(starts).toEqual([0, 100, 200, 300, 400, 500, 600, 700, 800, 900]);
    expect(result.items).toHaveLength(990);
    expect(result.items.at(-1)?.id).toBe(990);
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
    expect((await searchSmartPlaylistSongs(rule)).items).toEqual([]);
  });
});
