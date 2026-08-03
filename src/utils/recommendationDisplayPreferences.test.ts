import { describe, expect, it } from 'vitest';
import {
  compactRecommendationHint,
  readRecommendationHintsEnabled,
  writeRecommendationHintsEnabled,
} from './recommendationDisplayPreferences';

function createStorage(initial?: string): Storage {
  let value = initial ?? null;
  return {
    getItem: () => value,
    setItem: (_key, next) => { value = next; },
    removeItem: () => { value = null; },
    clear: () => { value = null; },
    key: () => null,
    get length() { return value === null ? 0 : 1; },
  };
}

describe('recommendation display preferences', () => {
  it('keeps recommendation hints hidden by default', () => {
    expect(readRecommendationHintsEnabled(createStorage())).toBe(false);
  });

  it('persists explicit hint visibility', () => {
    const storage = createStorage();
    writeRecommendationHintsEnabled(true, storage);
    expect(readRecommendationHintsEnabled(storage)).toBe(true);
    writeRecommendationHintsEnabled(false, storage);
    expect(readRecommendationHintsEnabled(storage)).toBe(false);
  });

  it('turns explanatory recommendation copy into compact labels', () => {
    expect(compactRecommendationHint('音響的に近いおすすめ')).toBe('音が近い');
    expect(compactRecommendationHint('履歴・評価をもとにした既知のおすすめ')).toBe('好みから');
    expect(compactRecommendationHint('7日で+12,345')).toBe('7日で+12,345');
  });
});
