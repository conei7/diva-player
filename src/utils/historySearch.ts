import type { Song } from '../types/vocadb';

export interface HistorySearchEntry {
  song: Pick<Song, 'name' | 'artistString'>;
  playedAt: number;
}

export function matchesHistoryQuery(song: Pick<Song, 'name' | 'artistString'>, query: string): boolean {
  const normalizedQuery = query.trim().toLocaleLowerCase('ja-JP');
  if (!normalizedQuery) return true;
  return song.name.toLocaleLowerCase('ja-JP').includes(normalizedQuery)
    || (song.artistString ?? '').toLocaleLowerCase('ja-JP').includes(normalizedQuery);
}

export function filterHistoryEntries<T extends HistorySearchEntry>(entries: T[], query: string): T[] {
  if (!query.trim()) return entries;
  return entries.filter(entry => matchesHistoryQuery(entry.song, query));
}
