import type { Song } from '../types/vocadb';

export interface HistoryLikeEntry {
  song: Song;
  playedAt: number;
}

export interface ScoredSong {
  song: Song;
  score: number;
}

export interface ImplicitSongFeedbackLike {
  skipCount: number;
  completeCount: number;
  removeCount: number;
  lastSkippedAt?: number;
  lastCompletedAt?: number;
  lastRemovedAt?: number;
}

const ONE_HOUR = 60 * 60 * 1000;
const ONE_DAY = 24 * ONE_HOUR;

export function uniqueSongsById(songs: Song[]): Song[] {
  const seen = new Set<number>();
  const result: Song[] = [];

  for (const song of songs) {
    if (seen.has(song.id)) continue;
    seen.add(song.id);
    result.push(song);
  }

  return result;
}

export function buildPlaylistSongSet(playlists: { songs: Song[] }[]): Set<number> {
  const ids = new Set<number>();

  for (const playlist of playlists) {
    for (const song of playlist.songs) {
      ids.add(song.id);
    }
  }

  return ids;
}

export function getPlaylistSongs(playlists: { songs: Song[] }[]): Song[] {
  return uniqueSongsById(playlists.flatMap(playlist => playlist.songs));
}

export function weightedShuffleByScore<T>(
  items: T[],
  getScore: (item: T) => number,
): T[] {
  const pool = items.map(item => ({
    item,
    score: Math.max(0.001, getScore(item)),
  }));
  const result: T[] = [];

  while (pool.length > 0) {
    const total = pool.reduce((sum, entry) => sum + entry.score, 0);
    let cursor = Math.random() * total;
    let selectedIndex = pool.length - 1;

    for (let index = 0; index < pool.length; index++) {
      cursor -= pool[index].score;
      if (cursor <= 0) {
        selectedIndex = index;
        break;
      }
    }

    const [selected] = pool.splice(selectedIndex, 1);
    result.push(selected.item);
  }

  return result;
}

export function getArtistBucket(song: Song): string {
  const producer = song.artists?.find(artist => artist.categories?.includes('Producer'));
  if (producer?.artist?.id) return `producer:${producer.artist.id}`;
  if (song.artistString) return `artist:${song.artistString}`;
  return `song:${song.id}`;
}

export function diversifyByArtist(songs: Song[], maxPerBucket: number): Song[] {
  const counts = new Map<string, number>();
  const result: Song[] = [];

  for (const song of songs) {
    const bucket = getArtistBucket(song);
    const count = counts.get(bucket) ?? 0;
    if (count >= maxPerBucket) continue;
    counts.set(bucket, count + 1);
    result.push(song);
  }

  return result;
}

export function rankKnownSongs(
  historyEntries: HistoryLikeEntry[],
  playlistSongs: Song[],
  ratings: Record<string, number>,
  excludeIds = new Set<number>(),
  implicitFeedback: Record<string, ImplicitSongFeedbackLike> = {},
): ScoredSong[] {
  const now = Date.now();
  const scored = new Map<number, ScoredSong>();

  const addScore = (song: Song, score: number) => {
    if (excludeIds.has(song.id)) return;
    const existing = scored.get(song.id);
    if (existing) {
      existing.score += score;
    } else {
      scored.set(song.id, { song, score });
    }
  };

  historyEntries.forEach((entry, index) => {
    const ageDays = Math.max(0, (now - entry.playedAt) / ONE_DAY);
    const recency = Math.exp(-ageDays / 21);
    const listPosition = Math.max(0.2, 1 - index / 250);
    addScore(entry.song, 3.0 * recency + 1.0 * listPosition);
  });

  for (const song of playlistSongs) {
    addScore(song, 2.4);
  }

  for (const item of scored.values()) {
    const rating = ratings[String(item.song.id)] ?? 0;
    if (rating >= 3) item.score *= 1 + (rating - 2) * 0.25;
    item.score = applyImplicitFeedbackMultiplier(item.song, item.score, rating, implicitFeedback);
    item.score *= 1 + Math.log10(Math.max(1, item.song.favoritedTimes ?? 1)) * 0.08;
  }

  return [...scored.values()].sort((a, b) => b.score - a.score);
}

export function scoreQueueCandidates(
  candidates: Song[],
  historyEntries: HistoryLikeEntry[],
  playlistSongIds: Set<number>,
  ratings: Record<string, number>,
  existingIds: Set<number>,
  implicitFeedback: Record<string, ImplicitSongFeedbackLike> = {},
): ScoredSong[] {
  const now = Date.now();
  const lastPlayedMap = new Map<number, number>();

  for (const entry of historyEntries) {
    const existing = lastPlayedMap.get(entry.song.id);
    if (!existing || entry.playedAt > existing) {
      lastPlayedMap.set(entry.song.id, entry.playedAt);
    }
  }

  return uniqueSongsById(candidates)
    .filter(song => !existingIds.has(song.id))
    .map(song => {
      let score = 1.0;

      const lastPlayed = lastPlayedMap.get(song.id);
      if (lastPlayed) {
        const hoursAgo = (now - lastPlayed) / ONE_HOUR;
        if (hoursAgo < 1) score *= 0.0;
        else if (hoursAgo < 3) score *= 0.25;
        else if (hoursAgo < 12) score *= 0.75;
        else if (hoursAgo < 24) score *= 0.95;
        else score *= 1.4;
      }

      if (playlistSongIds.has(song.id)) {
        score *= 1.8;
      }

      const rating = ratings[String(song.id)] ?? 0;
      if (rating >= 3) score *= 1 + (rating - 2) * 0.3;
      score = applyImplicitFeedbackMultiplier(song, score, rating, implicitFeedback);

      score *= 1 + Math.log10(Math.max(1, song.favoritedTimes ?? 1)) * 0.05;

      return { song, score };
    })
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score);
}

function applyImplicitFeedbackMultiplier(
  song: Song,
  score: number,
  rating: number,
  feedbackMap: Record<string, ImplicitSongFeedbackLike>,
): number {
  const feedback = feedbackMap[String(song.id)];
  if (!feedback) return score;

  const negative = feedback.skipCount + feedback.removeCount * 2;
  const positive = feedback.completeCount;
  if (negative === 0 && positive === 0) return score;

  let multiplier = 1.0;
  multiplier *= Math.pow(0.72, Math.min(negative, 5));
  multiplier *= Math.pow(1.04, Math.min(positive, 5));

  const lastNegativeAt = Math.max(feedback.lastSkippedAt ?? 0, feedback.lastRemovedAt ?? 0);
  if (lastNegativeAt > 0) {
    const hoursAgo = (Date.now() - lastNegativeAt) / ONE_HOUR;
    if (hoursAgo < 6) multiplier *= 0.45;
    else if (hoursAgo < 24) multiplier *= 0.7;
    else if (hoursAgo < 72) multiplier *= 0.85;
  }

  if (rating >= 3) {
    multiplier = Math.max(multiplier, 0.75);
  }

  return score * Math.max(0.05, Math.min(2.0, multiplier));
}
