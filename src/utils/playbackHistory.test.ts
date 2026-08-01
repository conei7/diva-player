import { describe, expect, it } from 'vitest';
import { shouldRecordPlayback } from './playbackHistory';

describe('shouldRecordPlayback', () => {
  it('waits for history hydration', () => {
    expect(shouldRecordPlayback(false, true, 1)).toBe(false);
  });

  it('does not record a restored persisted player queue', () => {
    expect(shouldRecordPlayback(true, true, 0)).toBe(false);
  });

  it('records a new playback after the player advances its sequence', () => {
    expect(shouldRecordPlayback(true, true, 1)).toBe(true);
  });
});
