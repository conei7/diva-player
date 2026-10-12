import { describe, expect, it } from 'vitest';
import type { SoundMapPoint } from '../api/soundMap';
import {
  arrowKeyDirection,
  centerSoundMapOnPoint,
  clampSoundMapZoom,
  fitSoundMapItems,
  nearestInDirection,
  pickSoundMapFallbackSeed,
  pushSoundMapTrail,
  readSoundMapTrail,
  soundMapSimilarityPercent,
  visibleSoundMapItems,
} from './soundMap';

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

  it('rounds similarity to a whole percent', () => {
    expect(soundMapSimilarityPercent(0.973)).toBe(97);
    expect(soundMapSimilarityPercent(1.2)).toBe(100);
    expect(soundMapSimilarityPercent(null)).toBeNull();
  });

  it('moves between points with the arrow keys, preferring points along the pressed axis', () => {
    const grid = [
      { id: 1, x: 0, y: 0 },
      { id: 2, x: 1, y: 0.1 },
      { id: 3, x: 0.5, y: 2 },
      { id: 4, x: -1, y: 0 },
      { id: 5, x: 0, y: -1 },
    ];
    expect(arrowKeyDirection('ArrowRight')).toBe('right');
    expect(arrowKeyDirection('Enter')).toBeNull();
    expect(nearestInDirection(grid, 1, 'right')?.id).toBe(2);
    expect(nearestInDirection(grid, 1, 'left')?.id).toBe(4);
    expect(nearestInDirection(grid, 1, 'down')?.id).toBe(3);
    expect(nearestInDirection(grid, 1, 'up')?.id).toBe(5);
    expect(nearestInDirection(grid, 4, 'left')).toBeNull();
    expect(nearestInDirection(grid, 99, 'left')?.id).toBe(1);
  });

  it('keeps the previous-starting-song trail in history state, capped at 20', () => {
    expect(readSoundMapTrail(undefined)).toEqual([]);
    expect(readSoundMapTrail({ soundMapTrail: [1, 'x', -2, 3] })).toEqual([1, 3]);
    const long = Array.from({ length: 25 }, (_, index) => index + 1);
    expect(pushSoundMapTrail(long, 99)).toHaveLength(20);
    expect(pushSoundMapTrail(long, 99).at(-1)).toBe(99);
    expect(pushSoundMapTrail([4], null)).toEqual([4]);
  });

  it('starts from recent history, then the best-rated song, then a playlist song', () => {
    const history = new Map([[10, 100], [11, 300], [12, 200]]);
    expect(pickSoundMapFallbackSeed({ lastPlayedAtBySongId: history })).toBe(11);
    expect(pickSoundMapFallbackSeed({ lastPlayedAtBySongId: history, excludedIds: new Set([11]) })).toBe(12);
    expect(pickSoundMapFallbackSeed({ playedIds: new Set([7, 8]) })).toBe(7);
    expect(pickSoundMapFallbackSeed({ ratings: { 20: 3, 21: 5, 22: 0 } })).toBe(21);
    expect(pickSoundMapFallbackSeed({ ratings: { 22: 0 }, playlistSongIds: [30, 31] })).toBe(30);
    expect(pickSoundMapFallbackSeed({})).toBeNull();
  });
});
