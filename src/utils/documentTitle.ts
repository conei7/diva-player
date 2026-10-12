import type { AppLanguage } from '../stores/languageStore';
import type { Song } from '../types/vocadb';

/**
 * Browser tab titles (also what the browser history and bookmarks show). Both languages live in
 * this file, like songMeta.ts: utils return text only with a `language` argument (DESIGN_SPEC §2.4).
 * index.html keeps the Japanese default; App replaces it right after start-up.
 */
const TITLES: Record<AppLanguage, { default: string; loading: string; unavailable: string; untitled: string }> = {
  ja: {
    default: 'DIVA Player — ボカロミュージックプレイヤー',
    loading: '曲を読み込み中 | DIVA Player',
    unavailable: '曲を読み込めませんでした | DIVA Player',
    untitled: '再生中',
  },
  en: {
    default: 'DIVA Player — Vocaloid music player',
    loading: 'Loading song | DIVA Player',
    unavailable: "Couldn't load this song | DIVA Player",
    untitled: 'Now playing',
  },
};

type DocumentTitleSong = Pick<Song, 'name' | 'artistString'>;

/** The title while no song is playing (and of index.html in Japanese). */
export function defaultDocumentTitle(language: AppLanguage): string {
  return TITLES[language].default;
}

/** The song page while its song is still loading. */
export function watchLoadingDocumentTitle(language: AppLanguage): string {
  return TITLES[language].loading;
}

/** The song page when its song could not be loaded. */
export function watchUnavailableDocumentTitle(language: AppLanguage): string {
  return TITLES[language].unavailable;
}

/** Builds the browser tab title without depending on Media Session support. */
export function formatDocumentTitle(song: DocumentTitleSong | null | undefined, language: AppLanguage): string {
  if (!song) return defaultDocumentTitle(language);

  const name = song.name.trim() || TITLES[language].untitled;
  const artist = song.artistString.trim();
  return artist
    ? `${name} — ${artist} | DIVA Player`
    : `${name} | DIVA Player`;
}
