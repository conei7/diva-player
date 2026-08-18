export type AutoQueueReasonCode =
  | 'long_term_taste'
  | 'short_term_taste'
  | 'root_seed'
  | 'known_favorite'
  | 'playlist_familiar'
  | 'new_discovery'
  | 'fallback';

export type AutoQueueStatus = 'idle' | 'fetching' | 'reranking' | 'ready' | 'relaxed' | 'degraded' | 'exhausted' | 'error';
/** Autoplay has one supported policy. Legacy persisted decisions may still
 * contain the removed arm names, but new decisions are always balanced. */
export type AutoQueueStrategyArm = 'balanced';

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
  /** Continuous preference used by current mixes. Legacy records may omit it. */
  familiarityBias?: number;
  /** Legacy quota-shaped telemetry retained only for persisted-record compatibility. */
  targetKnown?: number;
  targetUnknown?: number;
  recentSkipRate: number;
  strategyArm: AutoQueueStrategyArm;
}
