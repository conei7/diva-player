import { expect, it } from 'vitest';
import { layoutSoundMapOrigins } from './soundMapOrigins';

it('separates seven coincident origin markers without changing their actual positions', () => {
  const origins = Array.from({ length: 7 }, (_, i) => ({ songId: i + 1, x: 200, y: 200 }));
  const original = structuredClone(origins);
  const offsets = layoutSoundMapOrigins(origins, 640, 480);
  const positions = origins.map(p => ({ x: p.x + offsets.get(p.songId)!.dx, y: p.y + offsets.get(p.songId)!.dy }));
  for (let i = 0; i < positions.length; i++)
    for (let j = i + 1; j < positions.length; j++)
      expect(Math.hypot(positions[i].x - positions[j].x, positions[i].y - positions[j].y)).toBeGreaterThanOrEqual(29);
  expect(origins).toEqual(original);
  expect(layoutSoundMapOrigins(origins, 640, 480)).toEqual(offsets);
});

it('keeps edge markers on a phone and leaves offscreen origins offscreen', () => {
  const origins = Array.from({ length: 7 }, (_, i) => ({ songId: i, x: 2, y: 2 }));
  origins.push({ songId: 100, x: -500, y: -500 });
  const offsets = layoutSoundMapOrigins(origins, 390, 472);
  expect(offsets.has(100)).toBe(false);
  for (const p of origins.slice(0, 7)) {
    expect(p.x + offsets.get(p.songId)!.dx).toBeGreaterThanOrEqual(16);
    expect(p.y + offsets.get(p.songId)!.dy).toBeGreaterThanOrEqual(16);
  }
});
