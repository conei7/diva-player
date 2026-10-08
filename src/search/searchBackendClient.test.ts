import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildSearchQuery, searchSongsBackend } from './searchBackendClient';

const baseParams = {
  sort: 'FavoritedTimes' as const,
  sortOrder: 'desc' as const,
  start: 12,
  maxResults: 28,
};

describe('backend search card responses', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('displays the default title in results from older backend data', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        items: [{ id: 443372, name: 'ゲドウ', defaultName: 'GEDO' }],
        totalCount: 1,
      }),
    }));

    const result = await searchSongsBackend({ ...baseParams, query: 'canonical-title' });

    expect(result.items[0].name).toBe('GEDO');
    expect(result.totalCount).toBe(1);
  });

  it('opts into compact cards without changing default search requests', () => {
    const regular = buildSearchQuery(baseParams);
    const compact = buildSearchQuery({ ...baseParams, compactCards: true });

    expect(regular.has('compact')).toBe(false);
    expect(compact.get('compact')).toBe('true');
    expect(compact.get('start')).toBe('12');
    expect(compact.get('maxResults')).toBe('28');
  });
});
