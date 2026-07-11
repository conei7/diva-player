import type { AutoQueueStrategyArm } from '../types/autoplay';
import type { KnownUnknownTarget } from './autoQueuePolicy';

export const AUTO_QUEUE_STRATEGY_ARMS: AutoQueueStrategyArm[] = ['familiar', 'balanced', 'explore'];
export const MIN_BANDIT_DECISIONS = 30;

export interface BetaDistribution {
  alpha: number;
  beta: number;
}

export type StrategyBanditStats = Record<AutoQueueStrategyArm, BetaDistribution>;

export function createDefaultBanditStats(): StrategyBanditStats {
  return {
    familiar: { alpha: 1, beta: 1 },
    balanced: { alpha: 1, beta: 1 },
    explore: { alpha: 1, beta: 1 },
  };
}

export function updateBanditStats(
  stats: StrategyBanditStats,
  arm: AutoQueueStrategyArm,
  outcome: 'complete' | 'skip' | 'neutral',
): StrategyBanditStats {
  if (outcome === 'neutral') return stats;
  const distribution = stats[arm];
  return {
    ...stats,
    [arm]: outcome === 'complete'
      ? { ...distribution, alpha: distribution.alpha + 1 }
      : { ...distribution, beta: distribution.beta + 1 },
  };
}

/** Marsaglia and Tsang gamma sampler, used to sample a beta distribution. */
function sampleGamma(shape: number, random: () => number): number {
  if (shape < 1) return sampleGamma(shape + 1, random) * Math.pow(random(), 1 / shape);
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  while (true) {
    let x: number;
    let y: number;
    do {
      const u = Math.max(Number.EPSILON, random());
      const v = Math.max(Number.EPSILON, random());
      x = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
      y = 1 + c * x;
    } while (y <= 0);
    const v = y * y * y;
    const u = random();
    if (u < 1 - 0.0331 * x ** 4 || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

export function sampleBeta(distribution: BetaDistribution, random = Math.random): number {
  const x = sampleGamma(Math.max(Number.EPSILON, distribution.alpha), random);
  const y = sampleGamma(Math.max(Number.EPSILON, distribution.beta), random);
  return x / (x + y);
}

export function selectThompsonArm(
  stats: StrategyBanditStats,
  sample: (distribution: BetaDistribution) => number = distribution => sampleBeta(distribution),
): AutoQueueStrategyArm {
  let best = AUTO_QUEUE_STRATEGY_ARMS[0];
  let bestScore = sample(stats[best]);
  for (const arm of AUTO_QUEUE_STRATEGY_ARMS.slice(1)) {
    const score = sample(stats[arm]);
    if (score > bestScore) {
      best = arm;
      bestScore = score;
    }
  }
  return best;
}

export function adjustTargetForStrategy(target: KnownUnknownTarget, arm: AutoQueueStrategyArm): KnownUnknownTarget {
  const total = target.known + target.unknown;
  const shift = arm === 'familiar' ? 0.1 : arm === 'explore' ? -0.1 : 0;
  const known = Math.max(0, Math.min(total, Math.round(target.known + total * shift)));
  return { known, unknown: total - known };
}
