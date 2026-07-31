import type { Song } from '../types/vocadb';

export const DEFAULT_DOCUMENT_TITLE = 'DIVA Player — ボカロミュージックプレイヤー';

type DocumentTitleSong = Pick<Song, 'name' | 'artistString'>;

/** Builds the browser tab title without depending on Media Session support. */
export function formatDocumentTitle(song: DocumentTitleSong | null | undefined): string {
  if (!song) return DEFAULT_DOCUMENT_TITLE;

  const name = song.name.trim() || '再生中';
  const artist = song.artistString.trim();
  return artist
    ? `${name} — ${artist} | DIVA Player`
    : `${name} | DIVA Player`;
}
