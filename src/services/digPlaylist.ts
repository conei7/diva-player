import type { GlobalFilterSettings } from '../stores/globalFilterStore';
import type { HistoryEntry } from '../stores/historyStore';
import type { ImplicitSongFeedback } from '../stores/implicitFeedbackStore';
import type { Song } from '../types/vocadb';
import { getDigRecommendedSongs, type DigRecommendationSeed } from '../api/vocadb';
import { getPlayedSongIds } from './historyDatabase';
import { applyGlobalSongFilter } from '../utils/globalFilters';
import { filterVoiceSynthSongs } from '../utils/voiceSynthSongs';

export const DIG_TARGET_COUNT = 50;
export const DIG_PAGE_SIZE = 100;
export const DIG_MAX_PAGES = 4;

export interface DigGenerationInput {
  historyEntries: HistoryEntry[];
  playlists: Array<{ songs: Song[] }>;
  ratings: Record<string, number>;
  implicitFeedback: Record<string, ImplicitSongFeedback>;
  favoriteProducerIds?: number[];
  globalFilters?: GlobalFilterSettings;
}

export interface DigGenerationResult {
  songs: Song[];
  generationSeed: number;
  candidateCount: number;
  knownCount: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function stableNoise(seed: number, id: number): number {
  let value = (Math.imul(seed | 0, 1103515245) + Math.imul(id | 0, 12345) + 0x6d2b79f5) | 0;
  value ^= value >>> 15;
  value = Math.imul(value, 2246822519);
  value ^= value >>> 13;
  return (value >>> 0) / 0xffffffff;
}

export function createDigGenerationSeed(now = Date.now()): number {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
      const values = new Uint32Array(1);
      crypto.getRandomValues(values);
      return values[0] | 0;
    }
  } catch {
    // A timestamp fallback is sufficient for browsers with restricted crypto.
  }
  return (now ^ (now >>> 16)) | 0;
}

function addScore(scores: Map<number, number>, songId: number, score: number): void {
  if (!Number.isInteger(songId) || songId <= 0 || !Number.isFinite(score) || score <= 0) return;
  scores.set(songId, (scores.get(songId) ?? 0) + score);
}

/** Builds a small, privacy-preserving set of representative song IDs. */
export function buildDigTasteSeeds(
  input: Pick<DigGenerationInput, 'historyEntries' | 'playlists' | 'ratings' | 'implicitFeedback'>,
  generationSeed = 0,
  now = Date.now(),
): DigRecommendationSeed[] {
  const scores = new Map<number, number>();
  for (const entry of input.historyEntries) {
    const ageDays = Math.max(0, (now - entry.playedAt) / DAY_MS);
    const feedback = input.implicitFeedback[String(entry.song.id)];
    const rating = input.ratings[String(entry.song.id)] ?? 0;
    const negative = (feedback?.skipCount ?? 0) + (feedback?.removeCount ?? 0) * 2;
    const positive = (feedback?.manualCompleteCount ?? 0) + (feedback?.completeCount ?? 0);
    if (negative > positive && rating < 3) continue;
    addScore(scores, entry.song.id,
      Math.exp(-ageDays / 30) * 0.7
      + Math.max(0, rating - 2) * 0.55
      + Math.min(4, feedback?.manualCompleteCount ?? 0) * 0.35
      + Math.min(4, feedback?.autoCompleteCount ?? 0) * 0.08);
  }

  for (const playlist of input.playlists) {
    for (const song of playlist.songs) {
      const rating = input.ratings[String(song.id)] ?? 0;
      addScore(scores, song.id, 0.45 + Math.max(0, rating - 2) * 0.25);
    }
  }

  for (const [rawId, rating] of Object.entries(input.ratings)) {
    const songId = Number(rawId);
    if (rating >= 3) addScore(scores, songId, 0.4 + Math.min(5, rating) * 0.18);
  }

  for (const [rawId, feedback] of Object.entries(input.implicitFeedback)) {
    const songId = Number(rawId);
    const positive = (feedback.manualCompleteCount ?? 0) + feedback.completeCount;
    const negative = feedback.skipCount + feedback.removeCount * 2;
    if (positive > negative) addScore(scores, songId, Math.min(3, positive) * 0.12);
  }

  return [...scores.entries()]
    .sort((a, b) => {
      const scoreDiff = b[1] - a[1];
      if (Math.abs(scoreDiff) > 1e-9) return scoreDiff;
      return stableNoise(generationSeed, a[0]) - stableNoise(generationSeed, b[0]);
    })
    .slice(0, 24)
    .map(([songId, weight]) => ({ songId, weight: Math.max(0.2, Math.min(1, weight / 3)) }));
}

export function buildDigKnownIds(
  playedSongIds: Iterable<number>,
  ratings: Record<string, number>,
  implicitFeedback: Record<string, ImplicitSongFeedback>,
): Set<number> {
  const known = new Set<number>();
  for (const id of playedSongIds) if (Number.isInteger(id) && id > 0) known.add(id);
  for (const [rawId, rating] of Object.entries(ratings)) {
    const id = Number(rawId);
    if (rating > 0 && Number.isInteger(id) && id > 0) known.add(id);
  }
  for (const [rawId, feedback] of Object.entries(implicitFeedback)) {
    const id = Number(rawId);
    const hasFeedback = feedback.skipCount > 0
      || feedback.completeCount > 0
      || (feedback.manualCompleteCount ?? 0) > 0
      || (feedback.autoCompleteCount ?? 0) > 0
      || feedback.removeCount > 0;
    if (hasFeedback && Number.isInteger(id) && id > 0) known.add(id);
  }
  return known;
}

export function filterDigCandidates(
  songs: Song[],
  knownIds: ReadonlySet<number>,
  globalFilters?: GlobalFilterSettings,
): Song[] {
  const filtered = globalFilters ? applyGlobalSongFilter(songs, globalFilters) : songs;
  const seen = new Set<number>();
  return filterVoiceSynthSongs(filtered).filter(song => {
    if (knownIds.has(song.id) || seen.has(song.id)) return false;
    seen.add(song.id);
    return true;
  });
}

export async function generateDigPlaylist(
  input: DigGenerationInput,
  options: { generationSeed?: number; targetCount?: number } = {},
): Promise<DigGenerationResult> {
  const generationSeed = options.generationSeed ?? createDigGenerationSeed();
  const targetCount = Math.max(1, Math.min(DIG_TARGET_COUNT, Math.floor(options.targetCount ?? DIG_TARGET_COUNT)));
  const [playedSongIds] = await Promise.all([getPlayedSongIds()]);
  const knownIds = buildDigKnownIds(playedSongIds, input.ratings, input.implicitFeedback);
  // Keep the in-memory history as a fallback for private browsing and tests
  // where IndexedDB may be unavailable during the generation click.
  for (const entry of input.historyEntries) knownIds.add(entry.song.id);
  const seeds = buildDigTasteSeeds(input, generationSeed);
  const serverExclusions = [...knownIds].slice(-500);
  const candidates: Song[] = [];
  const acceptedIds = new Set<number>();

  for (let page = 0; page < DIG_MAX_PAGES && candidates.length < targetCount; page++) {
    const pageSongs = await getDigRecommendedSongs(
      seeds,
      input.favoriteProducerIds ?? [],
      DIG_PAGE_SIZE,
      serverExclusions,
      page * DIG_PAGE_SIZE,
      generationSeed,
    );
    if (pageSongs.length === 0) break;
    const filtered = filterDigCandidates(pageSongs, knownIds, input.globalFilters)
      .filter(song => !acceptedIds.has(song.id));
    filtered.forEach(song => acceptedIds.add(song.id));
    candidates.push(...filtered);
    if (pageSongs.length < DIG_PAGE_SIZE) break;
  }

  return {
    songs: candidates.slice(0, targetCount),
    generationSeed,
    candidateCount: candidates.length,
    knownCount: knownIds.size,
  };
}
