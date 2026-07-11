import { useEffect, useRef, useState } from 'react';
import {
  getAudioSimilarSongs,
  getMultiRecommendedSongs,
  getSongsByProducerFromBackend,
} from '../api/vocadb';
import type { Song } from '../types/vocadb';
import type { HistoryEntry } from '../stores/historyStore';
import type { ImplicitSongFeedback } from '../stores/implicitFeedbackStore';
import {
  buildPlaylistSongSet,
  getPlaylistSongs,
  rankKnownSongs,
  rerankForQueueDiversity,
  scoreQueueCandidates,
  uniqueSongsById,
} from '../utils/recommendationScoring';
import { createAutoQueuePlan, selectKnownUnknownMix, type AutoQueueAdaptation } from '../utils/autoQueuePolicy';
import { buildUserTasteProfile, type TasteSeed } from '../services/userTasteProfile';
import { useAutoPlaySessionStore } from '../stores/autoPlaySessionStore';
import { useAutoQueueDecisionStore } from '../stores/autoQueueDecisionStore';
import { useQueueRecommendationStore } from '../stores/queueRecommendationStore';
import { useAutoQueueStatusStore } from '../stores/autoQueueStatusStore';
import { useAutoQueueBanditStore } from '../stores/autoQueueBanditStore';
import { adjustTargetForStrategy } from '../utils/strategyBandit';
import type { AutoQueueDecision, AutoQueueStatus, AutoQueueStrategyArm, QueueRecommendation } from '../types/autoplay';

export type AutoQueueMixMode = 'balanced' | 'deep' | 'producer';

interface UseAutoQueueArgs {
  currentSong: Song | null;
  rootSeed: Song | null;
  mixMode: AutoQueueMixMode;
  queue: Song[];
  queueIndex: number;
  historyEntries: HistoryEntry[];
  ratings: Record<string, number>;
  playlists: { songs: Song[] }[];
  implicitFeedback: Record<string, ImplicitSongFeedback>;
  autoPlayedCount: number;
  adaptation: AutoQueueAdaptation;
  addManyToQueue: (songs: Song[], source: 'auto') => void;
}

function applyCandidatePenalties(
  candidates: Song[],
  historyEntries: HistoryEntry[],
  playlistSongIds: Set<number>,
  existingIds: Set<number>,
): Song[] {
  const now = Date.now();
  const oneHour = 60 * 60 * 1000;
  const lastPlayedMap = new Map<number, number>();
  for (const entry of historyEntries) {
    const existing = lastPlayedMap.get(entry.song.id);
    if (!existing || entry.playedAt > existing) lastPlayedMap.set(entry.song.id, entry.playedAt);
  }

  return candidates
    .filter(song => !existingIds.has(song.id))
    .map(song => {
      let score = 1;
      const lastPlayed = lastPlayedMap.get(song.id);
      if (lastPlayed) {
        const hoursAgo = (now - lastPlayed) / oneHour;
        if (hoursAgo < 1) score = 0;
        else if (hoursAgo < 3) score *= 0.1;
        else if (hoursAgo < 12) score *= 0.5;
        else if (hoursAgo < 24) score *= 0.8;
      }
      if (playlistSongIds.has(song.id)) score *= 1.3;
      return { song, score };
    })
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .map(item => item.song);
}

async function fetchCandidates(
  currentSong: Song,
  rootSeed: Song | null,
  mixMode: AutoQueueMixMode,
  tasteSeeds: TasteSeed[],
  excludeSongIds: number[],
): Promise<Song[]> {
  const songId = currentSong.id;
  const randomOffset = Math.floor(Math.random() * 20);

  switch (mixMode) {
    case 'deep':
      return getAudioSimilarSongs(songId, 40, randomOffset);
    case 'producer': {
      const producerIds = (currentSong.artists ?? [])
        .filter(artist => artist.categories?.includes('Producer'))
        .map(artist => artist.artist?.id)
        .filter((id): id is number => id !== undefined);
      return getSongsByProducerFromBackend(songId, producerIds, 40, randomOffset);
    }
    case 'balanced':
    default:
      void randomOffset;
      return getMultiRecommendedSongs(
        buildRecommendationSeeds(currentSong, rootSeed, tasteSeeds),
        60,
        excludeSongIds,
      );
  }
}

interface RecommendationSeed {
  songId: number;
  weight: number;
}

function buildRecommendationSeeds(currentSong: Song, rootSeed: Song | null, tasteSeeds: TasteSeed[]): RecommendationSeed[] {
  const byId = new Map<number, number>();
  const add = (songId: number, weight: number) => {
    byId.set(songId, Math.max(weight, byId.get(songId) ?? 0));
  };
  add(rootSeed?.id ?? currentSong.id, 1);
  add(currentSong.id, 0.9);
  for (const seed of tasteSeeds) add(seed.song.id, seed.weight * (seed.kind === 'shortTerm' ? 0.9 : 0.8));
  return [...byId.entries()]
    .map(([songId, weight]) => ({ songId, weight }))
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 5);
}

function buildRecommendationMetadata(
  songs: Song[],
  knownIds: Set<number>,
  playlistSongIds: Set<number>,
  tasteProfile: { longTerm: TasteSeed[]; shortTerm: TasteSeed[] },
  rootSeed: Song | null,
  currentSong: Song,
  stage: 'early' | 'middle' | 'late',
  target: { known: number; unknown: number },
  queueLength: number,
  recentSkipRate: number,
  strategyArm: AutoQueueStrategyArm,
): { queueRecommendations: Array<QueueRecommendation & { songId: number }>; decisions: AutoQueueDecision[] } {
  const now = Date.now();
  const sessionId = useAutoPlaySessionStore.getState().session?.id ?? null;
  const seedSongIds = [
    rootSeed?.id ?? currentSong.id,
    currentSong.id,
    ...tasteProfile.longTerm.map(seed => seed.song.id),
    ...tasteProfile.shortTerm.map(seed => seed.song.id),
  ].filter((id, index, ids) => ids.indexOf(id) === index);

  const queueRecommendations = songs.map(song => {
    const familiarity = knownIds.has(song.id) ? 'known' as const : 'unknown' as const;
    const isPlaylistSong = playlistSongIds.has(song.id);
    const reasonCode = familiarity === 'unknown'
      ? 'new_discovery' as const
      : isPlaylistSong ? 'playlist_familiar' as const : 'known_favorite' as const;
    const reasonText = familiarity === 'unknown'
      ? '長期・最近の好みに近い新規開拓曲'
      : isPlaylistSong ? 'プレイリストにある、聴き慣れた曲'
      : '履歴・評価をもとにした既知のおすすめ';
    return {
      songId: song.id,
      strategyVersion: 'fixed-known-unknown-v1',
      reasonCode,
      reasonText,
      seedSongIds,
      familiarity,
      generatedAt: now,
    };
  });
  return {
    queueRecommendations,
    decisions: queueRecommendations.map((recommendation, index) => ({
      ...recommendation,
      id: `${now}-${recommendation.songId}-${index}`,
      sessionId,
      queuePosition: queueLength + index,
      stage,
      targetKnown: target.known,
      targetUnknown: target.unknown,
      recentSkipRate,
      strategyArm,
    })),
  };
}

/**
 * Owns one refill request at a time. Dependency changes abort the result path
 * and increment the request generation so an old recommendation response can
 * never append songs for a different seed, mix mode, or queue state.
 */
export function useAutoQueue({
  currentSong,
  rootSeed,
  mixMode,
  queue,
  queueIndex,
  historyEntries,
  ratings,
  playlists,
  implicitFeedback,
  autoPlayedCount,
  adaptation,
  addManyToQueue,
}: UseAutoQueueArgs): AutoQueueStatus {
  const [status, setStatus] = useState<AutoQueueStatus>('idle');
  const requestGenerationRef = useRef(0);
  const { autoCompletedCount, autoSkippedCount, consecutiveSkips } = adaptation;

  useEffect(() => {
    useAutoQueueStatusStore.getState().setStatus(status);
  }, [status]);

  useEffect(() => {
    if (!currentSong) {
      setStatus('idle');
      return;
    }

    const remaining = queue.length - 1 - queueIndex;
    const queuePlan = createAutoQueuePlan(remaining, autoPlayedCount, {
      autoCompletedCount,
      autoSkippedCount,
      consecutiveSkips,
    });
    if (!queuePlan) {
      setStatus('ready');
      return;
    }
    const strategyArm = useAutoQueueBanditStore.getState().selectArm(
      useAutoQueueDecisionStore.getState().decisions.length,
    );
    const strategyTarget = adjustTargetForStrategy(queuePlan.target, strategyArm);

    const generation = ++requestGenerationRef.current;
    const controller = new AbortController();
    const existingIds = new Set(queue.map(song => song.id));
    const playlistSongIds = buildPlaylistSongSet(playlists);
    const playlistSongs = getPlaylistSongs(playlists);
    const tasteProfile = buildUserTasteProfile(historyEntries, playlists, ratings, implicitFeedback);
    setStatus('fetching');

    void (async () => {
      try {
        const candidates = await fetchCandidates(
          currentSong,
          rootSeed,
          mixMode,
          [...tasteProfile.longTerm, ...tasteProfile.shortTerm],
          [...existingIds],
        );
        if (controller.signal.aborted || generation !== requestGenerationRef.current) return;

        setStatus('reranking');
        const filteredCandidates = applyCandidatePenalties(candidates, historyEntries, playlistSongIds, existingIds);
        const knownCandidates = rankKnownSongs(
          historyEntries,
          playlistSongs,
          ratings,
          existingIds,
          implicitFeedback,
        ).map(item => item.song);
        const scored = scoreQueueCandidates(
          uniqueSongsById([...knownCandidates, ...filteredCandidates]),
          historyEntries,
          playlistSongIds,
          ratings,
          existingIds,
          implicitFeedback,
        ).slice(0, 80);
        const knownIds = new Set<number>([
          ...historyEntries.map(entry => entry.song.id),
          ...playlistSongs.map(song => song.id),
          ...Object.keys(ratings).map(Number),
          ...Object.keys(implicitFeedback).map(Number),
        ]);
        const mixedSongs = selectKnownUnknownMix(
          scored.filter(item => knownIds.has(item.song.id)).map(item => item.song),
          scored.filter(item => !knownIds.has(item.song.id)).map(item => item.song),
          strategyTarget,
          existingIds,
        );
        const nextSongs = rerankForQueueDiversity(mixedSongs, {
          recentSongs: queue.slice(Math.max(0, queueIndex - 4), queueIndex + 1),
        });
        if (controller.signal.aborted || generation !== requestGenerationRef.current) return;

        if (nextSongs.length === 0) {
          setStatus('exhausted');
          return;
        }
        addManyToQueue(nextSongs, 'auto');
        const outcomes = autoCompletedCount + autoSkippedCount;
        const recentSkipRate = outcomes > 0 ? autoSkippedCount / outcomes : 0;
        const metadata = buildRecommendationMetadata(
          nextSongs,
          knownIds,
          playlistSongIds,
          tasteProfile,
          rootSeed,
          currentSong,
          queuePlan.stage,
          strategyTarget,
          queue.length,
          recentSkipRate,
          strategyArm,
        );
        useQueueRecommendationStore.getState().recordRecommendations(metadata.queueRecommendations);
        useAutoQueueDecisionStore.getState().recordDecisions(metadata.decisions);
        setStatus('ready');
      } catch {
        if (controller.signal.aborted || generation !== requestGenerationRef.current) return;
        setStatus('degraded');
      }
    })();

    return () => controller.abort();
  }, [
    addManyToQueue,
    autoCompletedCount,
    autoSkippedCount,
    consecutiveSkips,
    autoPlayedCount,
    currentSong,
    historyEntries,
    implicitFeedback,
    mixMode,
    playlists,
    queue,
    queueIndex,
    ratings,
    rootSeed,
  ]);

  return status;
}
