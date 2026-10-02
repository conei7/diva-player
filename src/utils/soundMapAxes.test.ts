import { describe, expect, it } from 'vitest';
import { changeSoundMapAxes, randomSoundMapAxes, readSoundMapAxes } from './soundMapAxes';

describe('sound map feature axes', () => {
  it('restores zero-based URL axes including boundaries and repairs malformed or equal axes', () => {
    expect(readSoundMapAxes(new URLSearchParams('axisX=0&axisY=1023'))).toEqual([0, 1023]);
    expect(readSoundMapAxes(new URLSearchParams('axisX=-1&axisY=1024'))).toEqual([16, 822]);
    expect(readSoundMapAxes(new URLSearchParams('axisX=822&axisY=822'))).toEqual([822, 823]);
  });
  it('randomly selects distinct valid axes and avoids repeating the current pair', () => {
    expect(randomSoundMapAxes([0, 1], () => 0)).not.toEqual([0, 1]);
    for (let value = 0; value < 1; value += 0.013) {
      const pair = randomSoundMapAxes([16, 822], () => value);
      expect(pair[0]).not.toBe(pair[1]);
      pair.forEach(axis => expect(axis).toBeGreaterThanOrEqual(0));
      pair.forEach(axis => expect(axis).toBeLessThan(1024));
    }
  });
  it('keeps origin/version but clears a viewport and selection from the previous axes', () => {
    const original = new URLSearchParams('seedSongId=7&mapVersion=old&centerX=.2&centerY=.1&zoom=2&selectedSongId=8');
    const next = changeSoundMapAxes(original, [1023, 0]);
    expect(next.get('seedSongId')).toBe('7');
    expect(next.get('mapVersion')).toBe('old');
    expect(next.get('axisX')).toBe('1023');
    expect(next.get('layout')).toBe('features');
    expect(next.has('centerX')).toBe(false);
    expect(next.has('selectedSongId')).toBe(false);
    expect(original.has('centerX')).toBe(true);
    expect(changeSoundMapAxes(next, null).has('axisX')).toBe(false);
  });
});
