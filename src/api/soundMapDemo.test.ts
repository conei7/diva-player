import { describe, expect, it } from 'vitest';
import { getDemoSoundMap } from './soundMapDemo';

describe('getDemoSoundMap', () => {
  it('creates a deterministic ready map centered on the requested seed', () => {
    const first = getDemoSoundMap(123);
    const second = getDemoSoundMap(123);

    expect(first).toEqual(second);
    expect(first.state).toBe('ready');
    expect(first.origin).toMatchObject({ songId: 123, x: 0, y: 0 });
    expect(first.items).toHaveLength(29);
    expect(first.items.every(point => point.x >= -1 && point.x <= 1 && point.y >= -1 && point.y <= 1)).toBe(true);
  });

  it('keeps a custom version for URL-pinned demo sessions', () => {
    expect(getDemoSoundMap(456, 'demo-v2').mapVersion).toBe('demo-v2');
  });
});
