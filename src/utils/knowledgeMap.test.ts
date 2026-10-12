import { describe, expect, it } from 'vitest';
import type { PlatformKnowledgeMap } from '../api/knowledgeMap';
import {
  buildKnowledgeMapItems,
  capKnowledgeMapSongTiles,
  formatKnowledgePercent,
  layoutKnowledgeMap,
  splitKnowledgeMapRemainders,
} from './knowledgeMap';

function platform(overrides: Partial<PlatformKnowledgeMap> = {}): PlatformKnowledgeMap {
  return {
    platform: 'youtube',
    totalViews: 1_000,
    knownViews: 300,
    coverageRatio: 0.3,
    totalSongCount: 3,
    knownSongCount: 2,
    knownRemainderViews: 100,
    unknownRemainderViews: 400,
    tiles: [
      { songId: 1, name: 'Known', artistString: 'P', views: 200, known: true },
      { songId: 2, name: 'Unknown', artistString: 'Q', views: 300, known: false },
    ],
    ...overrides,
  };
}

describe('knowledge map data', () => {
  it('keeps known and unknown remainders so the complete platform total is represented', () => {
    const items = buildKnowledgeMapItems(platform());
    expect(items.reduce((sum, item) => sum + item.views, 0)).toBe(1_000);
    expect(items.find(item => item.id === 'known-remainder')).toMatchObject({ views: 100, known: true });
    expect(items.find(item => item.id === 'unknown-remainder')).toMatchObject({ views: 400, known: false });
  });

  it('uses the platform-specific values without combining YouTube and NicoNico', () => {
    const youtube = buildKnowledgeMapItems(platform({ platform: 'youtube', totalViews: 1_000 }));
    const nico = buildKnowledgeMapItems(platform({
      platform: 'nico',
      totalViews: 80,
      knownViews: 20,
      knownRemainderViews: 5,
      unknownRemainderViews: 25,
      tiles: [
        { songId: 1, name: 'Known', artistString: 'P', views: 15, known: true },
        { songId: 2, name: 'Unknown', artistString: 'Q', views: 35, known: false },
      ],
    }));
    expect(youtube.reduce((sum, item) => sum + item.views, 0)).toBe(1_000);
    expect(nico.reduce((sum, item) => sum + item.views, 0)).toBe(80);
  });

  it('lays every item inside the map and preserves the total rectangle area', () => {
    const rectangles = layoutKnowledgeMap(buildKnowledgeMapItems(platform()));
    expect(rectangles).toHaveLength(4);
    for (const rect of rectangles) {
      expect(rect.x).toBeGreaterThanOrEqual(0);
      expect(rect.y).toBeGreaterThanOrEqual(0);
      expect(rect.x + rect.width).toBeLessThanOrEqual(100.000001);
      expect(rect.y + rect.height).toBeLessThanOrEqual(100.000001);
    }
    const area = rectangles.reduce((sum, rect) => sum + rect.width * rect.height, 0);
    expect(area).toBeCloseTo(10_000, 5);
  });

  it('labels the remainders with the shared known / not-yet-known wording', () => {
    const items = buildKnowledgeMapItems(platform());
    expect(items.find(item => item.id === 'known-remainder')?.label).toBe('その他の知っている曲');
    expect(items.find(item => item.id === 'unknown-remainder')?.label).toBe('その他のまだ知らない曲');
  });

  it('folds songs past the tile limit into the matching remainder without changing the totals', () => {
    const tiles = Array.from({ length: 6 }, (_, index) => ({
      songId: index + 1,
      name: `Song ${index + 1}`,
      artistString: 'P',
      views: 100 - index * 10,
      known: index % 2 === 0,
    }));
    const items = buildKnowledgeMapItems(platform({ tiles, knownRemainderViews: 5, unknownRemainderViews: 0 }));
    const capped = capKnowledgeMapSongTiles(items, 2);
    expect(capped.filter(item => !item.aggregate).map(item => item.songId)).toEqual([1, 2]);
    // Songs 3 and 5 are known (80 + 60 views), song 4 and 6 are not (70 + 50 views).
    expect(capped.find(item => item.id === 'known-remainder')?.views).toBe(5 + 80 + 60);
    expect(capped.find(item => item.id === 'unknown-remainder')).toMatchObject({ views: 70 + 50, known: false, aggregate: true });
    const total = (list: typeof items) => list.reduce((sum, item) => sum + item.views, 0);
    expect(total(capped)).toBe(total(items));
    expect(total(capped.filter(item => item.known))).toBe(total(items.filter(item => item.known)));
    expect(items.find(item => item.id === 'known-remainder')?.views).toBe(5);
  });

  it('leaves short lists untouched', () => {
    const items = buildKnowledgeMapItems(platform());
    expect(capKnowledgeMapSongTiles(items, 40)).toEqual(items);
  });

  it('cuts the longer side of the real rectangle', () => {
    const halves = [
      { id: 'a', label: 'A', views: 50, known: true, aggregate: false },
      { id: 'b', label: 'B', views: 50, known: false, aggregate: false },
    ];
    const wide = layoutKnowledgeMap(halves, 2);
    expect(wide.map(rect => [rect.width, rect.height])).toEqual([[50, 100], [50, 100]]);
    const tall = layoutKnowledgeMap(halves, 0.5);
    expect(tall.map(rect => [rect.width, rect.height])).toEqual([[100, 50], [100, 50]]);
  });

  it('keeps the remainders out of the map while there are song tiles (known first)', () => {
    const { tiles, remainders } = splitKnowledgeMapRemainders(buildKnowledgeMapItems(platform()));
    expect(tiles.map(item => item.songId)).toEqual([2, 1]);
    expect(remainders.map(item => item.id)).toEqual(['known-remainder', 'unknown-remainder']);
  });

  it('lets the remainders fill the map when no song tile is left', () => {
    const unknownOnly = buildKnowledgeMapItems(platform()).filter(item => !item.known && item.aggregate);
    const { tiles, remainders } = splitKnowledgeMapRemainders(unknownOnly);
    expect(tiles.map(item => item.id)).toEqual(['unknown-remainder']);
    expect(remainders).toEqual([]);
    expect(splitKnowledgeMapRemainders([])).toEqual({ tiles: [], remainders: [] });
  });

  it('formats shares like the hero number', () => {
    expect(formatKnowledgePercent(0.55)).toBe('55.0%');
    expect(formatKnowledgePercent(0.8757)).toBe('87.6%');
    expect(formatKnowledgePercent(0.0043)).toBe('0.43%');
    expect(formatKnowledgePercent(0)).toBe('0.0%');
    expect(formatKnowledgePercent(1.2)).toBe('100.0%');
    expect(formatKnowledgePercent(Number.NaN)).toBe('0.0%');
  });
});
