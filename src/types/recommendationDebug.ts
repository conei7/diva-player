import type { RecommendationCandidateTrace } from '../utils/recommendationReranking';

export type RecommendationDebugSurface = 'home' | 'watch' | 'autoplay';

export interface RecommendationDebugSnapshot {
  id: string;
  surface: RecommendationDebugSurface;
  generatedAt: number;
  seedSongIds: number[];
  strategy?: string;
  familiarityBias: number;
  candidateCount: number;
  selectedCount: number;
  trace: RecommendationCandidateTrace[];
}
