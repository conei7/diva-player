import type { Song } from '../../types/vocadb';

export type LibraryLanguage = 'ja' | 'en';

/** One row of the history list: a song and the latest time it was played (that day / overall). */
export interface HistoryRowItem {
  key: string;
  song: Song;
  playedAt: number;
}

export interface HistoryDayGroup {
  /** 'YYYY-MM-DD' in the history time zone. */
  dayKey: string;
  items: HistoryRowItem[];
}

interface PlayedSong {
  song: Song;
  playedAt: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatter(locale: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const cacheKey = `${locale}|${JSON.stringify(options)}`;
  let cached = formatterCache.get(cacheKey);
  if (!cached) {
    cached = new Intl.DateTimeFormat(locale, options);
    formatterCache.set(cacheKey, cached);
  }
  return cached;
}

function localeOf(language: LibraryLanguage): string {
  return language === 'en' ? 'en-US' : 'ja-JP';
}

/** Calendar day of a timestamp in the given time zone: 'YYYY-MM-DD'. */
export function getDayKey(timestamp: number, timeZone: string): string {
  const parts = formatter('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date(timestamp));
  const year = parts.find(part => part.type === 'year')?.value;
  const month = parts.find(part => part.type === 'month')?.value;
  const day = parts.find(part => part.type === 'day')?.value;
  return year && month && day ? `${year}-${month}-${day}` : new Date(timestamp).toISOString().slice(0, 10);
}

function dayKeyToUtc(dayKey: string): number {
  const [year, month, day] = dayKey.split('-').map(Number);
  return Date.UTC(year, (month || 1) - 1, day || 1);
}

/**
 * Newest day first; inside a day the same song appears once with its latest play
 * (row key `${songId}:${dayKey}`), newest first.
 */
export function groupHistoryByDay(entries: readonly PlayedSong[], timeZone: string): HistoryDayGroup[] {
  const groups = new Map<string, Map<number, HistoryRowItem>>();
  for (const entry of entries) {
    const dayKey = getDayKey(entry.playedAt, timeZone);
    const rows = groups.get(dayKey) ?? new Map<number, HistoryRowItem>();
    const existing = rows.get(entry.song.id);
    if (!existing || entry.playedAt > existing.playedAt) {
      rows.set(entry.song.id, { key: `${entry.song.id}:${dayKey}`, song: entry.song, playedAt: entry.playedAt });
    }
    groups.set(dayKey, rows);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0))
    .map(([dayKey, rows]) => ({
      dayKey,
      items: [...rows.values()].sort((a, b) => b.playedAt - a.playedAt),
    }));
}

/** One row per song with its latest play, newest first (used when sorting by title or artist). */
export function latestPlayPerSong(entries: readonly PlayedSong[]): HistoryRowItem[] {
  const rows = new Map<number, HistoryRowItem>();
  for (const entry of entries) {
    const existing = rows.get(entry.song.id);
    if (!existing || entry.playedAt > existing.playedAt) {
      rows.set(entry.song.id, { key: `song:${entry.song.id}`, song: entry.song, playedAt: entry.playedAt });
    }
  }
  return [...rows.values()].sort((a, b) => b.playedAt - a.playedAt);
}

function capitalizeFirst(text: string): string {
  return text ? text.charAt(0).toLocaleUpperCase('en-US') + text.slice(1) : text;
}

/**
 * Heading of a day: 今日 / 昨日 / 水曜日 (within the last week) / 10月3日 / 2025年10月3日
 * (English: Today / Yesterday / Wednesday / Oct 3 / Oct 3, 2025).
 */
export function formatHistoryDayLabel(
  dayKey: string,
  now: number,
  timeZone: string,
  language: LibraryLanguage,
): string {
  const locale = localeOf(language);
  const todayKey = getDayKey(now, timeZone);
  const days = Math.round((dayKeyToUtc(todayKey) - dayKeyToUtc(dayKey)) / DAY_MS);
  if (days <= 1) {
    const relative = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(days === 1 ? -1 : 0, 'day');
    return language === 'en' ? capitalizeFirst(relative) : relative;
  }
  const date = new Date(dayKeyToUtc(dayKey));
  if (days < 7) return formatter(locale, { timeZone: 'UTC', weekday: 'long' }).format(date);
  const sameYear = todayKey.slice(0, 4) === dayKey.slice(0, 4);
  return formatter(locale, sameYear
    ? { timeZone: 'UTC', month: 'short', day: 'numeric' }
    : { timeZone: 'UTC', year: 'numeric', month: 'short', day: 'numeric' }).format(date);
}

/** Clock time of a play: '21:04' / '9:04 PM'. */
export function formatHistoryTime(timestamp: number, timeZone: string, language: LibraryLanguage): string {
  return formatter(localeOf(language), language === 'en'
    ? { timeZone, hour: 'numeric', minute: '2-digit' }
    : { timeZone, hour: 'numeric', minute: '2-digit', hourCycle: 'h23' }).format(new Date(timestamp));
}
