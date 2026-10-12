/**
 * Display names for stored names. Stored playlist names and queue titles
 * (playerStore.queueTitle) are never rewritten; pass them through these
 * helpers where they are shown so built-in names follow the UI language.
 */
import { WATCH_LATER_ID } from '../stores/playlistStore';

/** A source-text translator such as the function returned by useTranslateSourceText(). */
export type SourceTextTranslator = (source: string) => string;

/** 「後で聴く」 is translated; every other playlist keeps its own name. */
export function displayPlaylistName(playlist: { id: string; name: string }, ts: SourceTextTranslator): string {
  return playlist.id === WATCH_LATER_ID ? ts('後で聴く') : playlist.name;
}

/** Built-in queue titles in their current wording; any other title (a playlist name) is returned as it is. */
export function displayQueueTitle(title: string | undefined, ts: SourceTextTranslator): string {
  switch (title) {
    case undefined:
    case '':
      return '';
    case 'ミックスリスト':
    case 'ミックス':
      return ts('ミックス');
    case '発掘ミックス':
      return ts('発掘ミックス');
    case '15秒サビハイライト':
    case '15-second chorus highlights':
    case 'サビ発掘':
      return ts('サビ発掘');
    case '後で聴く':
      return ts('後で聴く');
    default:
      return title;
  }
}
