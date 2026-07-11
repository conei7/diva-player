import type { Song } from '../types/vocadb';
import { getArtistBucket } from './recommendationScoring';

export type RecommendationSource = 'known' | 'hybrid' | 'audio' | 'popular';

export interface SourcedRecommendation {
  song: Song;
  source: RecommendationSource;
  reason: string;
}

export interface RecommendationMixOptions {
  quotas: Partial<Record<RecommendationSource, number>>;
  total: number;
  maxPerProducer?: number;
  excludeIds?: ReadonlySet<number>;
}

const SOURCE_ORDER: RecommendationSource[] = ['known', 'hybrid', 'audio', 'popular'];

function chooseNextSource(remaining: Partial<Record<RecommendationSource, number>>): RecommendationSource | null {
  let result: RecommendationSource | null = null;
  let highest = 0;
  for (const source of SOURCE_ORDER) {
    const count = remaining[source] ?? 0;
    if (count > highest) {
      highest = count;
      result = source;
    }
  }
  return result;
}

/**
 * Applies source quotas while spreading results across sources and limiting a
 * producer's visible share. A second relaxed pass prevents sparse pools from
 * creating empty recommendation surfaces.
 */
export function mixRecommendationSources(
  pools: Partial<Record<RecommendationSource, SourcedRecommendation[]>>,
  { quotas, total, maxPerProducer = 3, excludeIds = new Set<number>() }: RecommendationMixOptions,
): SourcedRecommendation[] {
  const queueBySource = new Map<RecommendationSource, SourcedRecommendation[]>();
  for (const source of SOURCE_ORDER) queueBySource.set(source, [...(pools[source] ?? [])]);

  const remaining = { ...quotas };
  const result: SourcedRecommendation[] = [];
  const seen = new Set<number>(excludeIds);
  const producerCounts = new Map<string, number>();
  const deferred: SourcedRecommendation[] = [];

  const canUse = (candidate: SourcedRecommendation, enforceProducerCap: boolean) => {
    if (seen.has(candidate.song.id)) return false;
    return !enforceProducerCap || (producerCounts.get(getArtistBucket(candidate.song)) ?? 0) < maxPerProducer;
  };
  const add = (candidate: SourcedRecommendation) => {
    seen.add(candidate.song.id);
    const producer = getArtistBucket(candidate.song);
    producerCounts.set(producer, (producerCounts.get(producer) ?? 0) + 1);
    result.push(candidate);
  };

  while (result.length < total) {
    const source = chooseNextSource(remaining);
    if (!source) break;
    const pool = queueBySource.get(source) ?? [];
    const candidate = pool.shift();
    if (!candidate) {
      remaining[source] = 0;
      continue;
    }
    if (canUse(candidate, true)) {
      add(candidate);
      remaining[source] = Math.max(0, (remaining[source] ?? 0) - 1);
    } else {
      deferred.push(candidate);
    }
  }

  const fallback = [...deferred, ...SOURCE_ORDER.flatMap(source => queueBySource.get(source) ?? [])];
  for (const candidate of fallback) {
    if (result.length >= total) break;
    if (canUse(candidate, true)) add(candidate);
  }
  for (const candidate of fallback) {
    if (result.length >= total) break;
    if (canUse(candidate, false)) add(candidate);
  }

  return result;
}

export function reasonForSource(source: RecommendationSource): string {
  switch (source) {
    case 'known': return '履歴・評価・プレイリストをもとにしたおすすめ';
    case 'hybrid': return '音響・タグ・アーティスト情報を合わせた類似曲';
    case 'audio': return '音響的に近い新規開拓曲';
    case 'popular': return '人気・話題性を加味した発見枠';
  }
}
