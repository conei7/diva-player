import type { AutoQueueStrategyArm } from '../types/autoplay';

export const AUTO_QUEUE_STRATEGY_ARMS: AutoQueueStrategyArm[] = ['balanced'];
export const MIN_BANDIT_DECISIONS = 0;

export interface BetaDistribution {
  alpha: number;
  beta: number;
}

export type StrategyBanditStats = Record<AutoQueueStrategyArm, BetaDistribution>;

export function createDefaultBanditStats(): StrategyBanditStats {
  return {
    balanced: { alpha: 1, beta: 1 },
  };
}

export function updateBanditStats(
  stats: StrategyBanditStats,
  arm: AutoQueueStrategyArm,
  outcome: 'complete' | 'skip' | 'neutral',
): StrategyBanditStats {
  void arm;
  const distribution = stats.balanced ?? { alpha: 1, beta: 1 };
  if (outcome === 'neutral') return { balanced: distribution };
  return {
    balanced: outcome === 'complete'
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

export function adjustFamiliarityBiasForStrategy(bias: number, arm: AutoQueueStrategyArm): number {
  void arm;
  return bias;
}

/** A deterministic-test-friendly offline simulation for tuning strategy arms. */
export function simulateThompsonSampling(
  rewardRates: Record<AutoQueueStrategyArm, number>,
  rounds: number,
  random = Math.random,
): { stats: StrategyBanditStats; selections: Record<AutoQueueStrategyArm, number> } {
  let stats = createDefaultBanditStats();
  const selections: Record<AutoQueueStrategyArm, number> = { balanced: 0 };
  for (let round = 0; round < Math.max(0, Math.floor(rounds)); round++) {
    const arm = selectThompsonArm(stats, distribution => sampleBeta(distribution, random));
    selections[arm]++;
    const outcome = random() < rewardRates[arm] ? 'complete' : 'skip';
    stats = updateBanditStats(stats, arm, outcome);
  }
  return { stats, selections };
}
