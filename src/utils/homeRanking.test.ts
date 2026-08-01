import { describe, expect, it } from 'vitest';
import { isDeterministicHomeRankingCategory } from './homeRanking';

describe('home ranking categories', () => {
  it('keeps the four ranking tabs deterministic', () => {
    expect(['popular', 'pace', 'trending', 'recent'].every(isDeterministicHomeRankingCategory)).toBe(true);
  });

  it('leaves discovery and recommendation tabs eligible for exploration', () => {
    expect(isDeterministicHomeRankingCategory('recommended')).toBe(false);
    expect(isDeterministicHomeRankingCategory('deep')).toBe(false);
    expect(isDeterministicHomeRankingCategory('history_based')).toBe(false);
    expect(isDeterministicHomeRankingCategory('favorite_producers')).toBe(false);
  });
});
