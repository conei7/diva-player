import { describe, expect, it } from 'vitest';
import type { PlatformKnowledgeMap } from '../api/knowledgeMap';
import { buildKnowledgeMapItems, layoutKnowledgeMap } from './knowledgeMap';

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
});
