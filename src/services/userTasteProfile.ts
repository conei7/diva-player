import type { Song } from '../types/vocadb';
import type { HistoryEntry } from '../stores/historyStore';
import type { ImplicitSongFeedback } from '../stores/implicitFeedbackStore';
import { uniqueSongsById } from '../utils/recommendationScoring';

export type TasteSeedKind = 'longTerm' | 'shortTerm' | 'playlist';

export interface TasteSeed {
  song: Song;
  weight: number;
  kind: TasteSeedKind;
}

export interface UserTasteProfile {
  longTerm: TasteSeed[];
  shortTerm: TasteSeed[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

function hasDominantNegativeFeedback(feedback: ImplicitSongFeedback | undefined): boolean {
  if (!feedback) return false;
  const positive = (feedback.manualCompleteCount ?? 0) + (feedback.autoCompleteCount ?? 0) + feedback.completeCount;
  const negative = feedback.skipCount + feedback.removeCount * 2;
  return negative > positive;
}

function topSeeds(entries: Array<{ song: Song; score: number; kind: TasteSeedKind }>, limit: number): TasteSeed[] {
  const seen = new Set<number>();
  return entries
    .sort((a, b) => b.score - a.score)
    .filter(entry => {
      if (seen.has(entry.song.id)) return false;
      seen.add(entry.song.id);
      return true;
    })
    .slice(0, limit)
    .map(entry => ({
      song: entry.song,
      weight: Math.max(0.2, Math.min(1, entry.score / 8)),
      kind: entry.kind,
    }));
}

/**
 * Builds lightweight browser-local representative seeds. It intentionally
 * keeps raw history in the browser and passes only selected song IDs onward.
 */
export function buildUserTasteProfile(
  historyEntries: HistoryEntry[],
  playlists: { songs: Song[] }[],
  ratings: Record<string, number>,
  implicitFeedback: Record<string, ImplicitSongFeedback>,
  now = Date.now(),
): UserTasteProfile {
  const longTermEntries: Array<{ song: Song; score: number; kind: TasteSeedKind }> = [];
  const shortTermEntries: Array<{ song: Song; score: number; kind: TasteSeedKind }> = [];
  const playlistSongs = uniqueSongsById(playlists.flatMap(playlist => playlist.songs));

  for (const song of playlistSongs) {
    const rating = ratings[String(song.id)] ?? 0;
    longTermEntries.push({ song, score: 2.4 + Math.max(0, rating - 2) * 1.5, kind: 'playlist' });
  }

  for (const entry of historyEntries) {
    const feedback = implicitFeedback[String(entry.song.id)];
    if (hasDominantNegativeFeedback(feedback) && (ratings[String(entry.song.id)] ?? 0) < 3) continue;
    const ageDays = Math.max(0, (now - entry.playedAt) / DAY_MS);
    const rating = ratings[String(entry.song.id)] ?? 0;
    const manualCompletes = feedback?.manualCompleteCount ?? 0;
    const autoCompletes = feedback?.autoCompleteCount ?? 0;
    const longScore = Math.exp(-ageDays / 21) * 2
      + Math.max(0, rating - 2) * 2.5
      + Math.min(4, manualCompletes) * 0.9
      + Math.min(4, autoCompletes) * 0.1;
    longTermEntries.push({ song: entry.song, score: longScore, kind: 'longTerm' });

    if (ageDays <= 1.5) {
      const shortScore = Math.exp(-ageDays / 0.5) * 3
        + Math.max(0, rating - 2) * 1.5
        + Math.min(2, manualCompletes) * 0.8;
      shortTermEntries.push({ song: entry.song, score: shortScore, kind: 'shortTerm' });
    }
  }

  return {
    longTerm: topSeeds(longTermEntries, 3),
    shortTerm: topSeeds(shortTermEntries, 2),
  };
}
