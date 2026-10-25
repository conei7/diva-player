import { describe, expect, it } from 'vitest';
import { KnowledgeAtlasIndex } from './knowledgeAtlas';

describe('full knowledge atlas', () => {
  it('keeps every song, with the same views-to-area ratio across the complete catalog', () => {
    const pairs = Array.from({ length: 2000 }, (_, i) => [i + 1, 2000 - i]).flat();
    const atlas = new KnowledgeAtlasIndex(pairs, new Set([1, 1800]));
    let area = 0;
    for (let i = 0; i < atlas.length; i++) {
      const rect = atlas.locate(i, 2)!;
      area += rect.width * rect.height;
      expect(rect.width * rect.height).toBeCloseTo(atlas.views[i] / atlas.totalViews, 12);
      expect(atlas.hit(rect.x + rect.width / 2, rect.y + rect.height / 2, 2)?.index).toBe(i);
    }
    expect(atlas.length).toBe(2000);
    expect(area).toBeCloseTo(1, 12);
    expect(atlas.locate(0, 2)).toMatchObject({ x: 0, y: 0 });
    expect(atlas.locate(1999, 2)?.x).toBeGreaterThan(0);
    expect(atlas.locate(1999, 2)?.y).toBeGreaterThan(0);
  });
  it('reaches the final low-view song of 500,000 without creating a tail bucket', () => {
    const pairs = Array.from({ length: 500000 }, (_, i) => [i + 1, 500000 - i]).flat();
    const atlas = new KnowledgeAtlasIndex(pairs, new Set([500000]));
    const last = atlas.locate(499999, 2)!;
    expect(atlas.ids[last.index]).toBe(500000);
    expect(atlas.views[last.index]).toBe(1);
    expect(last.knownRatio).toBe(1);
    expect(atlas.hit(last.x + last.width / 2, last.y + last.height / 2, 2)?.index).toBe(499999);
    const visible = atlas.visible({ x: 0, y: 0, width: 1, height: 1 }, 1200, 600, 2);
    expect(visible.length).toBeLessThan(6000);
    const zoom = 4096;
    const deep = atlas.visible({ x: last.x, y: last.y, width: 1200 / (3600 * zoom), height: 600 / (1800 * zoom) }, 3600 * zoom, 1800 * zoom, 2);
    expect(deep.some(rect => rect.index === 499999)).toBe(true);
    expect(deep.length).toBeLessThan(6000);
  });
  it('filters the same catalog by local known IDs, without an unknown remainder', () => {
    const pairs = [1, 1000, 2, 50, 3, 1];
    const known = new KnowledgeAtlasIndex(pairs, new Set([1, 3]), 'known');
    const unknown = new KnowledgeAtlasIndex(pairs, new Set([1, 3]), 'unknown');
    expect([...known.ids]).toEqual([1, 3]); expect(known.totalViews).toBe(1001);
    expect([...unknown.ids]).toEqual([2]); expect(unknown.totalViews).toBe(50);
    expect(new KnowledgeAtlasIndex(pairs, new Set(), 'known').hit(0.5, 0.5, 2)).toBeNull();
  });
  it('clips rendering without changing the area or placement at another zoom', () => {
    const atlas = new KnowledgeAtlasIndex([1, 900, 2, 90, 3, 10], new Set());
    const leaf = atlas.locate(2, 2)!;
    const before = atlas.locate(0, 2);
    expect(atlas.visible(leaf, 100000, 50000, 2).find(rect => rect.index === 2)).toEqual(leaf);
    expect(atlas.locate(0, 2)).toEqual(before);
    expect(atlas.hit(-0.1, 0.5, 2)).toBeNull(); expect(atlas.locate(4, 2)).toBeNull();
  });
  it('rejects malformed numeric data instead of drawing corrupt areas', () => {
    for (const pairs of [[1], [1, 0], [1, -2], [0, 1], [1, NaN], [1, 1, 2, 2]]) {
      expect(() => new KnowledgeAtlasIndex(pairs, new Set())).toThrow();
    }
  });
});
