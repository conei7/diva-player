/**
 * Pure helpers shared by the playlist screens (library cards, list rows, detail hero,
 * dialogs). Display text is produced by the callers with t().
 */
import type { AppLanguage } from '../../stores/languageStore';
import type { Playlist } from '../../types/vocadb';
import { smartPlaylistSortLabel, type SmartPlaylistRuleItem } from '../../utils/smartPlaylist';
import { formatCompactCount, songTypeLabel } from '../../utils/songMeta';
import { getWideSongThumbnailCandidates } from '../../utils/songThumbnail';

export type PlaylistSyncService = 'youtube' | 'niconico';

export interface PlaylistSyncInfo {
  service: PlaylistSyncService;
  status?: 'never' | 'success' | 'partial' | 'error';
  sourceUrl: string;
  lastSuccessfulAt?: number;
  unmatchedCount: number;
}

/** The YouTube / Niconico list this playlist mirrors, or null. */
export function getPlaylistSyncInfo(playlist: Pick<Playlist, 'youtubeSync' | 'nicoSync'>): PlaylistSyncInfo | null {
  const youtube = playlist.youtubeSync;
  if (youtube?.enabled) {
    return {
      service: 'youtube',
      status: youtube.lastStatus,
      sourceUrl: youtube.sourceUrl,
      lastSuccessfulAt: youtube.lastSuccessfulAt,
      unmatchedCount: youtube.lastUnmatchedCount ?? 0,
    };
  }
  const nico = playlist.nicoSync;
  if (nico?.enabled) {
    return {
      service: 'niconico',
      status: nico.lastStatus,
      sourceUrl: nico.sourceUrl,
      lastSuccessfulAt: nico.lastSuccessfulAt,
      unmatchedCount: nico.lastUnmatchedCount ?? 0,
    };
  }
  return null;
}

/**
 * Images to try for a playlist's 16:9 cover, best first: the chosen cover (when it is one of
 * the songs' thumbnails, that song's wide YouTube thumbnails instead of the small 4:3 one),
 * then the first song's wide thumbnails. Empty → show the icon.
 */
export function getPlaylistCoverCandidates(playlist: Pick<Playlist, 'coverArtUrl' | 'songs'>): string[] {
  const candidates: string[] = [];
  const add = (url?: string) => {
    const value = url?.trim();
    if (value && !candidates.includes(value)) candidates.push(value);
  };
  const cover = playlist.coverArtUrl?.trim();
  if (cover) {
    const coverSong = playlist.songs.find(song => song.thumbUrl?.trim() === cover);
    if (coverSong) getWideSongThumbnailCandidates(coverSong).forEach(add);
    add(cover);
  }
  const first = playlist.songs[0];
  if (first) getWideSongThumbnailCandidates(first).forEach(add);
  return candidates;
}

/** One smart playlist rule as a chip label in the UI language (view counts as 「100万回以上」 / 1M+). */
export function formatSmartRuleItem(
  item: SmartPlaylistRuleItem,
  t: (source: string, values?: Record<string, string | number>) => string,
  language: AppLanguage,
): string {
  switch (item.kind) {
    case 'producer':
      return t('ボカロP: {name}', { name: item.name });
    case 'minViews': {
      const count = formatCompactCount(item.count, language);
      return item.service === 'youtube' ? t('YouTube {count}回以上', { count }) : t('ニコニコ {count}回以上', { count });
    }
    case 'excludedSongTypes':
      return t('除外: {types}', { types: item.types.map(type => songTypeLabel(type, language)).join(language === 'ja' ? '・' : ', ') });
    case 'publishYear':
      return t('公開年 {from}〜{to}', { from: item.from || t('指定なし'), to: item.to || t('指定なし') });
    case 'length':
      return t('長さ {from}〜{to} 秒', { from: item.min || '0', to: item.max || '∞' });
    case 'video':
      if (item.service === 'both') return t('動画: YouTube＋ニコニコ');
      return item.service === 'youtube' ? t('動画: YouTube') : t('動画: ニコニコ');
    case 'audioAnalysis':
      return item.analyzed ? t('音響解析: 解析済み') : t('音響解析: 未解析');
    case 'noRules':
      return t('条件なし');
    case 'maxSongs':
      return t('上限 {count}曲', { count: item.count });
    case 'sort':
      return t(smartPlaylistSortLabel(item.sortBy));
  }
}

/** Clipboard write with a selection-based fallback. Resolves false when both fail. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the textarea fallback (e.g. permission denied).
  }
  if (typeof document === 'undefined') return false;
  const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.top = '0';
  textarea.style.left = '0';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  try {
    textarea.select();
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    textarea.remove();
    previousFocus?.focus({ preventScroll: true });
  }
}

/** Classes for text inputs, textareas and selects inside the playlist dialogs. */
export const PLAYLIST_FIELD_CLASS = 'playlist-field w-full';

/** Small grey label above a field. */
export const PLAYLIST_FIELD_LABEL_CLASS = 'mb-1.5 block text-sm font-medium leading-5 text-yt-text';

/** The library shows one chip at a time: a kind, 未分類, or a folder (`folder:<id>`). */
export type PlaylistLibraryFilter = 'all' | 'smart' | 'synced' | 'unfiled' | `folder:${string}`;

export function folderIdOfFilter(filter: PlaylistLibraryFilter): string | null {
  return filter.startsWith('folder:') ? filter.slice('folder:'.length) : null;
}
