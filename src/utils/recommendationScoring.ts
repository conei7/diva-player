import type { Song } from '../types/vocadb';

export interface HistoryLikeEntry {
  song: Song;
  playedAt: number;
}

export interface ScoredSong {
  song: Song;
  score: number;
  breakdown?: QueueCandidateScoreBreakdown;
}

export interface ImplicitFeedbackBreakdown {
  skipCount: number;
  removeCount: number;
  manualCompleteCount: number;
  autoCompleteCount: number;
  legacyCompleteCount: number;
  negativeEvents: number;
  positiveEvents: number;
  recentNegativeMultiplier: number;
  multiplier: number;
}

export interface QueueCandidateScoreBreakdown {
  baseScore: number;
  recencyMultiplier: number;
  lastPlayedAt?: number;
  playlistMultiplier: number;
  ratingMultiplier: number;
  implicitFeedback: ImplicitFeedbackBreakdown;
  popularityMultiplier: number;
  finalScore: number;
}

export interface ImplicitSongFeedbackLike {
  skipCount: number;
  completeCount: number;
  manualCompleteCount?: number;
  autoCompleteCount?: number;
  discoveryCompleteCount?: number;
  removeCount: number;
  lastSkippedAt?: number;
  lastCompletedAt?: number;
  lastRemovedAt?: number;
}

export interface TasteAffinityProfile {
  producers: Record<string, number>;
  vocalists: Record<string, number>;
  tags: Record<string, number>;
  signalSongCount: number;
}

export interface TasteAffinityBreakdown {
  producer: number;
  vocalist: number;
  tags: number;
  confidence: number;
  adjustment: number;
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

export function getVocalistIds(song: Song): number[] {
  return (song.artists ?? [])
    .filter(artist => artist.categories?.includes('Vocalist'))
    .map(artist => artist.artist?.id)
    .filter((id): id is number => id !== undefined);
}

export function getProducerIds(song: Song): number[] {
  return (song.artists ?? [])
    .filter(artist => String(artist.categories ?? '').split(',').map(value => value.trim())
      .some(category => category === 'Producer' || category === 'Band' || category === 'Circle'))
    .map(artist => artist.artist?.id)
    .filter((id): id is number => id !== undefined);
}

function getTasteTagKeys(song: Song): string[] {
  return [...new Set((song.tags ?? [])
    .map(item => item.tag?.name.normalize('NFKC').trim().toLocaleLowerCase('ja-JP'))
    .filter((name): name is string => Boolean(name)))]
    .slice(0, 12);
}

function addAffinity(target: Map<string, number>, keys: Array<string | number>, signal: number, weight = 1): void {
  const uniqueKeys = [...new Set(keys.map(String))];
  if (uniqueKeys.length === 0) return;
  const contribution = signal * weight / Math.sqrt(uniqueKeys.length);
  for (const key of uniqueKeys) target.set(key, (target.get(key) ?? 0) + contribution);
}

function normalizeAffinityMap(source: Map<string, number>): Record<string, number> {
  return Object.fromEntries([...source.entries()].map(([key, value]) => [
    key,
    Math.tanh(value / 3),
  ]));
}

/**
 * Builds a browser-local preference profile from intentional signals only.
 * Ordinary history and discovery completions never become positive evidence.
 */
export function buildTasteAffinityProfile(
  historyEntries: HistoryLikeEntry[],
  playlists: { songs: Song[] }[],
  ratings: Record<string, number>,
  implicitFeedback: Record<string, ImplicitSongFeedbackLike>,
): TasteAffinityProfile {
  const songs = new Map<number, Song>();
  for (const entry of historyEntries) songs.set(entry.song.id, entry.song);
  const playlistSongIds = new Set<number>();
  for (const playlist of playlists) {
    for (const song of playlist.songs) {
      songs.set(song.id, song);
      playlistSongIds.add(song.id);
    }
  }

  const producers = new Map<string, number>();
  const vocalists = new Map<string, number>();
  const tags = new Map<string, number>();
  let signalSongCount = 0;

  for (const song of songs.values()) {
    const rating = ratings[String(song.id)] ?? 0;
    const feedback = implicitFeedback[String(song.id)];
    let signal = playlistSongIds.has(song.id) ? 1.4 : 0;
    signal += rating === 5 ? 2.4 : rating === 4 ? 1.5 : rating === 3 ? 0.4 : rating === 2 ? -0.7 : rating === 1 ? -1.4 : 0;
    signal += Math.min(3, feedback?.manualCompleteCount ?? 0) * 0.45;
    signal += Math.min(2, feedback?.autoCompleteCount ?? 0) * 0.05;
    signal -= Math.min(3, feedback?.skipCount ?? 0) * 0.3;
    signal -= Math.min(2, feedback?.removeCount ?? 0) * 0.6;
    if (Math.abs(signal) < 0.2) continue;

    signalSongCount++;
    addAffinity(producers, getProducerIds(song), signal, 1);
    addAffinity(vocalists, getVocalistIds(song), signal, 0.7);
    addAffinity(tags, getTasteTagKeys(song), signal, 0.45);
  }

  return {
    producers: normalizeAffinityMap(producers),
    vocalists: normalizeAffinityMap(vocalists),
    tags: normalizeAffinityMap(tags),
    signalSongCount,
  };
}

function strongestAverage(keys: Array<string | number>, affinities: Record<string, number>, maximum: number): number {
  const values = [...new Set(keys.map(String))]
    .map(key => affinities[key] ?? 0)
    .filter(value => value !== 0)
    .sort((left, right) => Math.abs(right) - Math.abs(left))
    .slice(0, maximum);
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function explainTasteAffinity(song: Song, profile: TasteAffinityProfile): TasteAffinityBreakdown {
  const producer = strongestAverage(getProducerIds(song), profile.producers, 2);
  const vocalist = strongestAverage(getVocalistIds(song), profile.vocalists, 2);
  const tags = strongestAverage(getTasteTagKeys(song), profile.tags, 3);
  const available: Array<{ value: number; weight: number }> = [];
  if (producer !== 0) available.push({ value: producer, weight: 0.45 });
  if (vocalist !== 0) available.push({ value: vocalist, weight: 0.20 });
  if (tags !== 0) available.push({ value: tags, weight: 0.35 });
  const totalWeight = available.reduce((sum, item) => sum + item.weight, 0);
  const affinity = totalWeight === 0
    ? 0
    : available.reduce((sum, item) => sum + item.value * item.weight, 0) / totalWeight;
  const confidence = Math.min(1, profile.signalSongCount / 4);
  return {
    producer,
    vocalist,
    tags,
    confidence,
    adjustment: Math.max(-0.28, Math.min(0.28, affinity * confidence * 0.28)),
  };
}

export interface QueueDiversityOptions {
  recentSongs: Song[];
  producerLimit?: number;
  vocalistLimit?: number;
}

/**
 * Keeps all candidates available as fallbacks, but moves those that would make
 * the next queue window too homogeneous behind more varied candidates.
 */
export function rerankForQueueDiversity(
  candidates: Song[],
  { recentSongs, producerLimit = 2, vocalistLimit = 3 }: QueueDiversityOptions,
): Song[] {
  const producerCounts = new Map<string, number>();
  const vocalistCounts = new Map<number, number>();
  const add = (song: Song) => {
    const producer = getArtistBucket(song);
    producerCounts.set(producer, (producerCounts.get(producer) ?? 0) + 1);
    for (const vocalistId of getVocalistIds(song)) {
      vocalistCounts.set(vocalistId, (vocalistCounts.get(vocalistId) ?? 0) + 1);
    }
  };
  recentSongs.forEach(add);

  const preferred: Song[] = [];
  const deferred: Song[] = [];
  const seen = new Set<number>();
  for (const song of candidates) {
    if (seen.has(song.id)) continue;
    seen.add(song.id);
    const producerOverLimit = (producerCounts.get(getArtistBucket(song)) ?? 0) >= producerLimit;
    const vocalistOverLimit = getVocalistIds(song)
      .some(vocalistId => (vocalistCounts.get(vocalistId) ?? 0) >= vocalistLimit);
    if (producerOverLimit || vocalistOverLimit) {
      deferred.push(song);
      continue;
    }
    preferred.push(song);
    add(song);
  }
  return [...preferred, ...deferred];
}

export function diversifyAwayFromSeedVocalist(
  seedSong: Song,
  songs: Song[],
  maxSameSeedVocalist: number,
): Song[] {
  const seedVocalists = new Set(getVocalistIds(seedSong));
  if (seedVocalists.size === 0) return songs;

  const sameSeedVocalist: Song[] = [];
  const others: Song[] = [];

  for (const song of uniqueSongsById(songs)) {
    const hasSeedVocalist = getVocalistIds(song).some(id => seedVocalists.has(id));
    if (hasSeedVocalist) sameSeedVocalist.push(song);
    else others.push(song);
  }

  return uniqueSongsById([
    ...sameSeedVocalist.slice(0, maxSameSeedVocalist),
    ...others,
    ...sameSeedVocalist.slice(maxSameSeedVocalist),
  ]);
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
  const lastPlayedMap = new Map<number, number>();
  const now = Date.now();

  for (const entry of historyEntries) {
    const existing = lastPlayedMap.get(entry.song.id);
    if (!existing || entry.playedAt > existing) {
      lastPlayedMap.set(entry.song.id, entry.playedAt);
    }
  }

  return uniqueSongsById(candidates)
    .filter(song => !existingIds.has(song.id))
    .map(song => {
      const breakdown = explainQueueCandidateScore(
        song,
        historyEntries,
        playlistSongIds,
        ratings,
        implicitFeedback,
        lastPlayedMap,
        now,
      );

      return { song, score: breakdown.finalScore, breakdown };
    })
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score);
}

export function explainQueueCandidateScore(
  song: Song,
  historyEntries: HistoryLikeEntry[],
  playlistSongIds: Set<number>,
  ratings: Record<string, number>,
  implicitFeedback: Record<string, ImplicitSongFeedbackLike> = {},
  lastPlayedMap?: Map<number, number>,
  now = Date.now(),
): QueueCandidateScoreBreakdown {
  const playedAt = lastPlayedMap?.get(song.id) ?? historyEntries
    .filter(entry => entry.song.id === song.id)
    .reduce<number | undefined>((latest, entry) => !latest || entry.playedAt > latest ? entry.playedAt : latest, undefined);

  let recencyMultiplier = 1.0;
  if (playedAt) {
    const hoursAgo = (now - playedAt) / ONE_HOUR;
    if (hoursAgo < 1) recencyMultiplier = 0.0;
    else if (hoursAgo < 3) recencyMultiplier = 0.25;
    else if (hoursAgo < 12) recencyMultiplier = 0.75;
    else if (hoursAgo < 24) recencyMultiplier = 0.95;
    else recencyMultiplier = 1.4;
  }

  const playlistMultiplier = playlistSongIds.has(song.id) ? 1.8 : 1.0;
  const rating = ratings[String(song.id)] ?? 0;
  const ratingMultiplier = rating >= 3 ? 1 + (rating - 2) * 0.3 : 1.0;
  const implicitFeedbackBreakdown = explainImplicitFeedback(song, rating, implicitFeedback);
  const popularityMultiplier = 1 + Math.log10(Math.max(1, song.favoritedTimes ?? 1)) * 0.05;
  const finalScore = 1.0
    * recencyMultiplier
    * playlistMultiplier
    * ratingMultiplier
    * implicitFeedbackBreakdown.multiplier
    * popularityMultiplier;

  return {
    baseScore: 1.0,
    recencyMultiplier,
    ...(playedAt ? { lastPlayedAt: playedAt } : {}),
    playlistMultiplier,
    ratingMultiplier,
    implicitFeedback: implicitFeedbackBreakdown,
    popularityMultiplier,
    finalScore,
  };
}

function applyImplicitFeedbackMultiplier(
  song: Song,
  score: number,
  rating: number,
  feedbackMap: Record<string, ImplicitSongFeedbackLike>,
): number {
  return score * explainImplicitFeedback(song, rating, feedbackMap).multiplier;
}

export function explainImplicitFeedback(
  song: Song,
  rating: number,
  feedbackMap: Record<string, ImplicitSongFeedbackLike>,
): ImplicitFeedbackBreakdown {
  const feedback = feedbackMap[String(song.id)];
  if (!feedback) {
    return {
      skipCount: 0,
      removeCount: 0,
      manualCompleteCount: 0,
      autoCompleteCount: 0,
      legacyCompleteCount: 0,
      negativeEvents: 0,
      positiveEvents: 0,
      recentNegativeMultiplier: 1,
      multiplier: 1,
    };
  }

  const negative = feedback.skipCount + feedback.removeCount * 2;
  const manualPositive = feedback.manualCompleteCount ?? 0;
  const autoPositive = feedback.autoCompleteCount ?? 0;
  const discoveryPositive = feedback.discoveryCompleteCount ?? 0;
  const legacyPositive = Math.max(0, feedback.completeCount - manualPositive - autoPositive - discoveryPositive);
  const positive = manualPositive + autoPositive + legacyPositive;
  if (negative === 0 && positive === 0) {
    return {
      skipCount: feedback.skipCount,
      removeCount: feedback.removeCount,
      manualCompleteCount: manualPositive,
      autoCompleteCount: autoPositive,
      legacyCompleteCount: legacyPositive,
      negativeEvents: negative,
      positiveEvents: positive,
      recentNegativeMultiplier: 1,
      multiplier: 1,
    };
  }

  let multiplier = 1.0;
  multiplier *= Math.pow(0.72, Math.min(negative, 5));
  multiplier *= Math.pow(1.08, Math.min(manualPositive, 5));
  multiplier *= Math.pow(1.015, Math.min(autoPositive, 5));
  multiplier *= Math.pow(1.03, Math.min(legacyPositive, 5));

  const lastNegativeAt = Math.max(feedback.lastSkippedAt ?? 0, feedback.lastRemovedAt ?? 0);
  let recentNegativeMultiplier = 1;
  if (lastNegativeAt > 0) {
    const hoursAgo = (Date.now() - lastNegativeAt) / ONE_HOUR;
    if (hoursAgo < 6) recentNegativeMultiplier = 0.45;
    else if (hoursAgo < 24) recentNegativeMultiplier = 0.7;
    else if (hoursAgo < 72) recentNegativeMultiplier = 0.85;
    multiplier *= recentNegativeMultiplier;
  }

  if (rating >= 3) {
    multiplier = Math.max(multiplier, 0.75);
  }

  return {
    skipCount: feedback.skipCount,
    removeCount: feedback.removeCount,
    manualCompleteCount: manualPositive,
    autoCompleteCount: autoPositive,
    legacyCompleteCount: legacyPositive,
    negativeEvents: negative,
    positiveEvents: positive,
    recentNegativeMultiplier,
    multiplier: Math.max(0.05, Math.min(2.0, multiplier)),
  };
}
