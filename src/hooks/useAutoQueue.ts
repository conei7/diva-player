import { useEffect, useRef, useState } from 'react';
import {
  getAudioSimilarSongs,
  getRecommendedSongs,
  getSongsByProducerFromBackend,
} from '../api/vocadb';
import type { Song } from '../types/vocadb';
import type { HistoryEntry } from '../stores/historyStore';
import type { ImplicitSongFeedback } from '../stores/implicitFeedbackStore';
import {
  buildPlaylistSongSet,
  getPlaylistSongs,
  rankKnownSongs,
  scoreQueueCandidates,
  uniqueSongsById,
} from '../utils/recommendationScoring';
import { createAutoQueuePlan, selectKnownUnknownMix } from '../utils/autoQueuePolicy';

export type AutoQueueStatus = 'idle' | 'fetching' | 'reranking' | 'ready' | 'degraded' | 'exhausted' | 'error';
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
): Promise<Song[]> {
  const songId = currentSong.id;
  const seedId = rootSeed?.id ?? songId;
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
      if (seedId === songId) return getRecommendedSongs(songId, 60, 0, undefined, randomOffset);
      return uniqueSongsById((await Promise.all([
        getRecommendedSongs(seedId, 30, 0, undefined, randomOffset),
        getRecommendedSongs(songId, 30, 0, undefined, randomOffset),
      ])).flat());
  }
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
  addManyToQueue,
}: UseAutoQueueArgs): AutoQueueStatus {
  const [status, setStatus] = useState<AutoQueueStatus>('idle');
  const requestGenerationRef = useRef(0);

  useEffect(() => {
    if (!currentSong) {
      setStatus('idle');
      return;
    }

    const remaining = queue.length - 1 - queueIndex;
    const queuePlan = createAutoQueuePlan(remaining, autoPlayedCount);
    if (!queuePlan) {
      setStatus('ready');
      return;
    }

    const generation = ++requestGenerationRef.current;
    const controller = new AbortController();
    const existingIds = new Set(queue.map(song => song.id));
    const playlistSongIds = buildPlaylistSongSet(playlists);
    const playlistSongs = getPlaylistSongs(playlists);
    setStatus('fetching');

    void (async () => {
      try {
        const candidates = await fetchCandidates(currentSong, rootSeed, mixMode);
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
        const nextSongs = selectKnownUnknownMix(
          scored.filter(item => knownIds.has(item.song.id)).map(item => item.song),
          scored.filter(item => !knownIds.has(item.song.id)).map(item => item.song),
          queuePlan.target,
          existingIds,
        );
        if (controller.signal.aborted || generation !== requestGenerationRef.current) return;

        if (nextSongs.length === 0) {
          setStatus('exhausted');
          return;
        }
        addManyToQueue(nextSongs, 'auto');
        setStatus('ready');
      } catch {
        if (controller.signal.aborted || generation !== requestGenerationRef.current) return;
        setStatus('degraded');
      }
    })();

    return () => controller.abort();
  }, [
    addManyToQueue,
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
