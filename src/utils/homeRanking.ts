export const DETERMINISTIC_HOME_RANKING_CATEGORIES = [
  'ranking',
  'popular',
  'pace',
  'trending',
  'recent',
] as const;

export type DeterministicHomeRankingCategory = typeof DETERMINISTIC_HOME_RANKING_CATEGORIES[number];

/**
 * These tabs are displayed as rankings, so their API order must be preserved.
 * Discovery/recommendation tabs may still apply their intentional exploration
 * and exposure adjustments.
 */
export function isDeterministicHomeRankingCategory(category: string): category is DeterministicHomeRankingCategory {
  return (DETERMINISTIC_HOME_RANKING_CATEGORIES as readonly string[]).includes(category);
}
