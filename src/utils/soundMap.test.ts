import { describe, expect, it } from 'vitest';
import type { SoundMapPoint } from '../api/soundMap';
import { centerSoundMapOnPoint, clampSoundMapZoom, fitSoundMapItems, visibleSoundMapItems } from './soundMap';

const points: SoundMapPoint[] = [
  { songId: 1, name: '起点', artistString: 'P', x: -0.4, y: 0.2, similarity: null },
  { songId: 2, name: '近い曲', artistString: 'Q', x: 0.1, y: 0.1, similarity: 0.9 },
  { songId: 3, name: '隠し曲', artistString: 'R', x: 0.4, y: -0.2, similarity: 0.8 },
];

describe('sound map helpers', () => {
  it('keeps zoom inside the interaction range', () => {
    expect(clampSoundMapZoom(0)).toBe(0.75);
    expect(clampSoundMapZoom(99)).toBe(5);
  });

  it('centers the viewport on the chosen origin', () => {
    expect(centerSoundMapOnPoint(points[0], 1.2)).toEqual({ zoom: 1.2, centerX: -0.4, centerY: 0.2 });
  });

  it('fits a compact neighborhood while preserving its center', () => {
    const viewport = fitSoundMapItems([{ x: -0.2, y: -0.1 }, { x: 0.2, y: 0.3 }]);
    expect(viewport.zoom).toBeCloseTo(3.846153846);
    expect(viewport.centerX).toBe(0);
    expect(viewport.centerY).toBeCloseTo(0.1);
  });

  it('removes hidden points without changing coordinates of visible points', () => {
    expect(visibleSoundMapItems(points, new Set([3])).map(point => point.songId)).toEqual([1, 2]);
    expect(points[1].x).toBe(0.1);
  });
});
