import { create } from 'zustand';
import { rankingNoise, type RankingSeed } from '../utils/rankingRandomization';

export type ExposureSurface =
  | 'home-recommended'
  | 'home-discovery'
  | 'watch-producer'
  | 'watch-related'
  | 'watch-recommended'
  | 'watch-deep'
  | 'now-playing-recommend'
  | 'now-playing-related'
  | 'now-playing-deepdig'
  | 'autoplay';

export interface RecommendationExposureEntry {
  songId: number;
  firstSeenAt: number;
  lastSeenAt: number;
  seenCount: number;
  lastSurface: ExposureSurface;
  lastRank: number;
  clickedCount: number;
  playedCount: number;
}

const STORAGE_KEY = 'diva-recommendation-exposure-v1';
const MAX_ENTRIES = 1000;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

function loadEntries(): Record<string, RecommendationExposureEntry> {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, RecommendationExposureEntry>;
    return Object.fromEntries(Object.entries(parsed).filter(([, entry]) => (
      entry && Number.isFinite(entry.lastSeenAt) && Date.now() - entry.lastSeenAt <= RETENTION_MS
    )));
  } catch {
    return {};
  }
}

function persist(entries: Record<string, RecommendationExposureEntry>): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // Storage can be disabled or full; recommendations must continue working.
  }
}

function prune(entries: Record<string, RecommendationExposureEntry>, now: number): Record<string, RecommendationExposureEntry> {
  const recent = Object.values(entries)
    .filter(entry => now - entry.lastSeenAt <= RETENTION_MS)
    .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
    .slice(0, MAX_ENTRIES);
  return Object.fromEntries(recent.map(entry => [String(entry.songId), entry]));
}

/** Returns a soft penalty in the same score range as recommendation reranking. */
export function calculateExposurePenalty(
  entry: RecommendationExposureEntry | undefined,
  now = Date.now(),
): number {
  if (!entry) return 0;
  const ageHours = Math.max(0, (now - entry.lastSeenAt) / (60 * 60 * 1000));
  const recency = Math.exp(-ageHours / 18);
  const repeat = Math.min(1.5, Math.log1p(Math.max(0, entry.seenCount - 1)) * 0.35);
  const interactionRelief = Math.min(0.55, entry.clickedCount * 0.12 + entry.playedCount * 0.20);
  return Math.max(0, recency * (0.26 + repeat) - interactionRelief);
}

interface RecommendationExposureState {
  entries: Record<string, RecommendationExposureEntry>;
  recordVisible: (songId: number, surface: ExposureSurface, rank: number) => void;
  recordClicked: (songId: number) => void;
  recordPlayed: (songId: number) => void;
  clear: () => void;
}

export const useRecommendationExposureStore = create<RecommendationExposureState>((set) => ({
  entries: loadEntries(),
  recordVisible: (songId, surface, rank) => set(state => {
    const now = Date.now();
    const current = state.entries[String(songId)];
    const nextEntry: RecommendationExposureEntry = current
      ? { ...current, lastSeenAt: now, seenCount: current.seenCount + 1, lastSurface: surface, lastRank: rank }
      : {
        songId,
        firstSeenAt: now,
        lastSeenAt: now,
        seenCount: 1,
        lastSurface: surface,
        lastRank: rank,
        clickedCount: 0,
        playedCount: 0,
      };
    const entries = prune({ ...state.entries, [String(songId)]: nextEntry }, now);
    persist(entries);
    return { entries };
  }),
  recordClicked: (songId) => set(state => {
    const current = state.entries[String(songId)];
    if (!current) return state;
    const entries = { ...state.entries, [String(songId)]: { ...current, clickedCount: current.clickedCount + 1 } };
    persist(entries);
    return { entries };
  }),
  recordPlayed: (songId) => set(state => {
    const current = state.entries[String(songId)];
    if (!current) return state;
    const entries = { ...state.entries, [String(songId)]: { ...current, playedCount: current.playedCount + 1 } };
    persist(entries);
    return { entries };
  }),
  clear: () => {
    if (typeof window !== 'undefined') window.localStorage.removeItem(STORAGE_KEY);
    set({ entries: {} });
  },
}));

export function getRecommendationExposureEntries(): Record<string, RecommendationExposureEntry> {
  return useRecommendationExposureStore.getState().entries;
}

/** Reorders an already-ranked API page without replacing its candidate pool. */
export function rerankDisplayedSongs<T extends { id: number }>(songs: T[], seed: RankingSeed): T[] {
  const entries = getRecommendationExposureEntries();
  const now = Date.now();
  return songs
    .map((song, index) => ({
      song,
      score: 1 - index / Math.max(1, songs.length) - calculateExposurePenalty(entries[String(song.id)], now) * 0.45
        + rankingNoise(seed, song.id) * 0.02,
    }))
    .sort((a, b) => b.score - a.score)
    .map(item => item.song);
}
