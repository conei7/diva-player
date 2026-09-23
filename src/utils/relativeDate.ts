import type { Song } from '../types/vocadb';

const DAY_MS = 24 * 60 * 60 * 1000;

export function getSongPublishedAt(song: Song): string | undefined {
  return song.publishDate
    ?? song.pvs?.find(pv => pv.pvType === 'Original' && pv.publishDate)?.publishDate
    ?? song.createDate;
}

/** YouTube-style relative publication date. */
export function formatRelativeDate(date: string | undefined, now = Date.now(), language: 'ja' | 'en' = 'ja'): string | null {
  if (!date) return null;
  const timestamp = Date.parse(date);
  if (Number.isNaN(timestamp)) return null;
  const days = Math.max(0, Math.floor((now - timestamp) / DAY_MS));
  if (language === 'en') {
    if (days === 0) return 'today';
    const relativeTime = new Intl.RelativeTimeFormat('en', { numeric: 'always' });
    if (days < 7) return relativeTime.format(-days, 'day');
    if (days < 30) return relativeTime.format(-Math.floor(days / 7), 'week');
    if (days < 365) return relativeTime.format(-Math.floor(days / 30), 'month');
    return relativeTime.format(-Math.floor(days / 365), 'year');
  }
  if (days === 0) return '今日';
  if (days < 7) return `${days}日前`;
  if (days < 30) return `${Math.floor(days / 7)}週間前`;
  if (days < 365) return `${Math.floor(days / 30)}か月前`;
  return `${Math.floor(days / 365)}年前`;
}

export function formatSongRelativeDate(song: Song, now = Date.now(), language: 'ja' | 'en' = 'ja'): string | null {
  return formatRelativeDate(getSongPublishedAt(song), now, language);
}
