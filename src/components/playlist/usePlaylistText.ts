import { useMemo } from 'react';
import { useTranslate, useTranslateSourceText } from '../../i18n';
import { useLanguageStore } from '../../stores/languageStore';
import type { Playlist } from '../../types/vocadb';
import { formatRelativeTime } from '../../utils/relativeDate';
import { getPlaylistSyncInfo, type PlaylistSyncService } from './playlistDisplay';

/** formatRelativeTime() says 「たった今」 for this (and for future times). */
const JUST_NOW_MS = 60 * 1000;

function isJustNow(timestamp: number, now: number): boolean {
  return Number.isFinite(timestamp) && now - timestamp < JUST_NOW_MS;
}

/** Labels that describe a playlist the same way on cards, rows and the detail page. */
export function usePlaylistText() {
  const t = useTranslateSourceText();
  const tk = useTranslate();
  const language = useLanguageStore(state => state.language);

  return useMemo(() => {
    const serviceName = (service: PlaylistSyncService) => (service === 'youtube' ? 'YouTube' : t('ニコニコ'));
    return {
      serviceName,
      /** 「プレイリスト」「スマートプレイリスト」「{service}と同期」 */
      kind(playlist: Playlist): string {
        if (playlist.smartRule) return t('スマートプレイリスト');
        const sync = getPlaylistSyncInfo(playlist);
        if (sync) return t('{service}と同期', { service: serviceName(sync.service) });
        return tk('playlistKindPlaylist');
      },
      /** True while the last sync failed (shown in red as 「同期エラー」). */
      syncFailed(playlist: Playlist): boolean {
        return getPlaylistSyncInfo(playlist)?.status === 'error';
      },
      /** 「最終更新: 3日前」 */
      updated(playlist: Pick<Playlist, 'updatedAt'>, now = Date.now()): string {
        return t('最終更新: {time}', { time: formatRelativeTime(playlist.updatedAt, now, language) });
      },
      relative(timestamp: number, now = Date.now()): string {
        return formatRelativeTime(timestamp, now, language);
      },
      /** 「3分前に同期」 (「たった今同期」, not 「たった今に同期」) */
      synced(timestamp: number, now = Date.now()): string {
        return isJustNow(timestamp, now)
          ? t('たった今同期')
          : t('{time}に同期', { time: formatRelativeTime(timestamp, now, language) });
      },
      /** 「3分前に更新」 (「たった今更新」) */
      refreshed(timestamp: number, now = Date.now()): string {
        return isJustNow(timestamp, now)
          ? t('たった今更新')
          : t('{time}に更新', { time: formatRelativeTime(timestamp, now, language) });
      },
      /** 24,955 */
      number(value: number): string {
        return value.toLocaleString(language === 'ja' ? 'ja-JP' : 'en-US');
      },
      language,
    };
  }, [language, t, tk]);
}
