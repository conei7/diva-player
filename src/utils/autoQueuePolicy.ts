export type AutoQueueStage = 'early' | 'middle' | 'late';

export interface AutoQueuePlan {
  stage: AutoQueueStage;
  /** Smooth 0..1 session position. It changes scoring, never reserves slots. */
  mixProgress: number;
  /** Positive values keep familiar songs softly preferred throughout a mix. */
  familiarityBias: number;
  requestedCount: number;
}

export interface AutoQueueAdaptation {
  autoCompletedCount: number;
  autoSkippedCount: number;
  consecutiveSkips: number;
}

export const AUTO_QUEUE_LOW_WATERMARK = 3;
export const AUTO_QUEUE_TARGET_WATERMARK = 12;
export const AUTO_QUEUE_MAX_BATCH_SIZE = 12;

/**
 * Session progress must be based on played automatic songs, not queue length.
 * Queue length changes whenever a refill succeeds and would otherwise make the
 * same session move backwards.
 */
export function getAutoQueueStage(autoPlayedCount: number): AutoQueueStage {
  if (autoPlayedCount < 5) return 'early';
  if (autoPlayedCount < 12) return 'middle';
  return 'late';
}

export function getAutoQueueMixProgress(autoPlayedCount: number): number {
  return 1 - Math.exp(-Math.max(0, autoPlayedCount) / 10);
}

export function getAutoQueueFamiliarityBias(
  autoPlayedCount: number,
  adaptation?: AutoQueueAdaptation,
): number {
  const progress = getAutoQueueMixProgress(autoPlayedCount);
  // Keep known songs favoured for the entire mix while letting that preference
  // relax gradually. This is intentionally a score, not a known/unknown quota.
  let bias = 0.45 - progress * 0.24;
  const outcomes = (adaptation?.autoCompletedCount ?? 0) + (adaptation?.autoSkippedCount ?? 0);
  const skipRate = outcomes > 0 ? (adaptation?.autoSkippedCount ?? 0) / outcomes : 0;
  if (skipRate >= 0.4 || (adaptation?.consecutiveSkips ?? 0) >= 2) {
    bias += 0.10;
  } else if (outcomes >= 5 && skipRate <= 0.1) {
    bias -= 0.05;
  }
  return Math.max(0.12, Math.min(0.55, bias));
}

export function createAutoQueuePlan(
  remainingCount: number,
  autoPlayedCount: number,
  adaptation?: AutoQueueAdaptation,
): AutoQueuePlan | null {
  if (remainingCount > AUTO_QUEUE_LOW_WATERMARK) return null;

  const requestedCount = Math.min(
    AUTO_QUEUE_MAX_BATCH_SIZE,
    Math.max(0, AUTO_QUEUE_TARGET_WATERMARK - Math.max(0, remainingCount)),
  );
  const stage = getAutoQueueStage(autoPlayedCount);
  return {
    stage,
    mixProgress: getAutoQueueMixProgress(autoPlayedCount),
    familiarityBias: getAutoQueueFamiliarityBias(autoPlayedCount, adaptation),
    requestedCount,
  };
}
