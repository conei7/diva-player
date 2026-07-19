export type AutoQueueReasonCode =
  | 'long_term_taste'
  | 'short_term_taste'
  | 'root_seed'
  | 'known_favorite'
  | 'playlist_familiar'
  | 'new_discovery'
  | 'fallback';

export type AutoQueueStatus = 'idle' | 'fetching' | 'reranking' | 'ready' | 'relaxed' | 'degraded' | 'exhausted' | 'error';
export type AutoQueueStrategyArm = 'familiar' | 'balanced' | 'explore';

export interface QueueRecommendation {
  strategyVersion: string;
  reasonCode: AutoQueueReasonCode;
  reasonText: string;
  seedSongIds: number[];
  familiarity: 'known' | 'unknown';
  generatedAt: number;
}

export interface AutoQueueDecision extends QueueRecommendation {
  id: string;
  sessionId: string | null;
  songId: number;
  queuePosition: number;
  stage: 'early' | 'middle' | 'late';
  targetKnown: number;
  targetUnknown: number;
  recentSkipRate: number;
  strategyArm: AutoQueueStrategyArm;
}
