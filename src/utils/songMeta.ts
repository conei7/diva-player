/**
 * Display helpers for song metadata (artists, counts, durations, enum labels).
 * Japanese and English labels live in this file so pages never show raw
 * VocaDB enum values (DESIGN_SPEC §2.3 / §5.5).
 */
import { isVoiceSynthArtistType } from '../config/voiceSynthTypes';
import type { AppLanguage } from '../stores/languageStore';
import type { ArtistForSong, Song, SongType } from '../types/vocadb';

type SongArtistSource = Pick<Song, 'artists' | 'artistString'>;

const FEAT_SEPARATOR = /\s+feat\.\s*/i;
const VARIANT_NAME = /^(.+?)\s+\([^)]+\)$/u;

function artistDisplayName(artist: ArtistForSong): string {
  return (artist.name || artist.artist?.name || '').trim();
}

/** Distinct names; voicebank variants ("初音ミク (V4X)") collapse into their base name when it is also credited. */
function distinctNames(names: string[]): string[] {
  const distinct = [...new Set(names.map(name => name.trim()).filter(Boolean))];
  const nameSet = new Set(distinct);
  return distinct.filter(name => {
    const base = name.match(VARIANT_NAME)?.[1];
    return !base || !nameSet.has(base);
  });
}

function splitArtistString(artistString: string | undefined): { producers: string; vocalists: string[] } {
  const [producers = '', vocalists = ''] = (artistString ?? '').split(FEAT_SEPARATOR, 2);
  return {
    producers: producers.trim(),
    vocalists: vocalists.split(/\s*,\s*/).map(name => name.trim()).filter(Boolean),
  };
}

/** Producers credited on the song; falls back to the part of artistString before " feat.". */
export function getProducerNames(song: SongArtistSource): string[] {
  const names = distinctNames((song.artists ?? [])
    .filter(artist => artist.categories?.includes('Producer'))
    .map(artistDisplayName));
  if (names.length > 0) return names;
  const { producers } = splitArtistString(song.artistString);
  return producers ? [producers] : [];
}

/** Main vocalists (support vocalists only when there is no main one); falls back to artistString after " feat.". */
export function getVocalistNames(song: SongArtistSource): string[] {
  const vocalists = (song.artists ?? []).filter(artist => artist.categories?.includes('Vocalist'));
  const main = vocalists.filter(artist => !artist.isSupport);
  const names = distinctNames((main.length > 0 ? main : vocalists).map(artistDisplayName));
  if (names.length > 0) return names;
  return splitArtistString(song.artistString).vocalists;
}

/**
 * The vocalists to name after the producers: getVocalistNames without anyone already credited as a
 * producer, so a self-cover reads 「バルーン」 rather than 「バルーン feat. バルーン」 (DESIGN_SPEC §2.1-9).
 */
export function getFeaturedVocalistNames(song: SongArtistSource): string[] {
  const producers = getProducerNames(song);
  if (producers.length === 0) return getVocalistNames(song);
  // The artistString fallback gives every producer as one "A, B" string: compare the parts too.
  const producerNames = new Set(producers.flatMap(name => [name, ...name.split(/\s*,\s*/)]));
  return getVocalistNames(song).filter(name => !producerNames.has(name));
}

/** 'wowaka' / 'wowaka feat. 初音ミク' (withVocalists). Never empty when artistString has text. */
export function formatArtistLine(song: SongArtistSource, options: { withVocalists?: boolean } = {}): string {
  const producers = getProducerNames(song).join(', ');
  const fallback = (song.artistString ?? '').trim();
  if (!options.withVocalists) return producers || fallback;
  const vocalists = getFeaturedVocalistNames(song).join(', ');
  if (producers && vocalists) return `${producers} feat. ${vocalists}`;
  return producers || vocalists || fallback;
}

const compactFormatters = new Map<AppLanguage, Intl.NumberFormat>();

function compactFormatter(language: AppLanguage): Intl.NumberFormat {
  let formatter = compactFormatters.get(language);
  if (!formatter) {
    formatter = new Intl.NumberFormat(language === 'ja' ? 'ja-JP' : 'en-US', {
      notation: 'compact',
      maximumSignificantDigits: 3,
    });
    compactFormatters.set(language, formatter);
  }
  return formatter;
}

function normalizeCount(count: number): number {
  return Number.isFinite(count) && count > 0 ? Math.round(count) : 0;
}

function groupedNumber(count: number, language: AppLanguage): string {
  return normalizeCount(count).toLocaleString(language === 'ja' ? 'ja-JP' : 'en-US');
}

/** Short count for chips and badges: '9,876' / '4470万' / '1.1億' / '999' / '44.7M' (3 significant digits). */
export function formatCompactCount(count: number, language: AppLanguage): string {
  const value = normalizeCount(count);
  const compactFrom = language === 'ja' ? 10_000 : 1_000;
  return value < compactFrom ? groupedNumber(value, language) : compactFormatter(language).format(value);
}

/** '4470万回再生' / '1.1億回再生' / '9,876回再生' / '44.7M views' / '1 view'. */
export function formatViewCount(count: number, language: AppLanguage): string {
  const compact = formatCompactCount(count, language);
  if (language === 'ja') return `${compact}回再生`;
  return normalizeCount(count) === 1 ? '1 view' : `${compact} views`;
}

const COUNT_UNITS: Record<'song' | 'video' | 'item', { ja: string; one: string; other: string }> = {
  song: { ja: '曲', one: 'song', other: 'songs' },
  video: { ja: '本', one: 'video', other: 'videos' },
  item: { ja: '件', one: 'item', other: 'items' },
};

/** '28曲' / '12本' / '120件' / '1 song' / '28 songs'. */
export function formatCount(count: number, unit: 'song' | 'video' | 'item', language: AppLanguage): string {
  const labels = COUNT_UNITS[unit];
  const value = normalizeCount(count);
  if (language === 'ja') return `${groupedNumber(value, language)}${labels.ja}`;
  return `${groupedNumber(value, language)} ${value === 1 ? labels.one : labels.other}`;
}

/** '3:45' / '1:02:03'. Invalid or negative input is '0:00'. */
export function formatClockDuration(seconds: number): string {
  const total = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = String(total % 60).padStart(2, '0');
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}`
    : `${minutes}:${rest}`;
}

/** Total length of a list: '1時間19分' / '34分' / '1 hr 19 min' / '34 min'. Rounded to minutes (at least 1 when > 0). */
export function formatTotalDuration(seconds: number, language: AppLanguage): string {
  const valid = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  const totalMinutes = valid > 0 ? Math.max(1, Math.round(valid / 60)) : 0;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (language === 'ja') {
    if (hours === 0) return `${minutes}分`;
    return minutes > 0 ? `${hours}時間${minutes}分` : `${hours}時間`;
  }
  if (hours === 0) return `${minutes} min`;
  return minutes > 0 ? `${hours} hr ${minutes} min` : `${hours} hr`;
}

const SONG_TYPE_TEXT: Record<SongType, { ja: string; en: string }> = {
  Original: { ja: 'オリジナル', en: 'Original' },
  Remaster: { ja: 'リマスター', en: 'Remaster' },
  Remix: { ja: 'リミックス', en: 'Remix' },
  Cover: { ja: 'カバー', en: 'Cover' },
  Arrangement: { ja: 'アレンジ', en: 'Arrangement' },
  Instrumental: { ja: 'インスト', en: 'Instrumental' },
  Mashup: { ja: 'マッシュアップ', en: 'Mashup' },
  MusicPV: { ja: 'PV', en: 'Music video' },
  DramaPV: { ja: 'ドラマPV', en: 'Drama video' },
  Other: { ja: 'その他', en: 'Other' },
  Unspecified: { ja: '未分類', en: 'Unspecified' },
};

/** 曲の種類 / Song type. */
export function songTypeLabel(type: SongType, language: AppLanguage): string {
  const text = SONG_TYPE_TEXT[type];
  if (!text) return language === 'ja' ? 'その他' : 'Other';
  return text[language];
}

const ARTIST_ROLE_TEXT: Record<string, { ja: string; en: string }> = {
  Default: { ja: 'その他', en: 'Other' },
  Other: { ja: 'その他', en: 'Other' },
  Composer: { ja: '作曲', en: 'Composer' },
  Lyricist: { ja: '作詞', en: 'Lyricist' },
  Arranger: { ja: '編曲', en: 'Arranger' },
  Illustrator: { ja: 'イラスト', en: 'Illustrator' },
  Animator: { ja: '動画', en: 'Animator' },
  Mixer: { ja: 'ミックス', en: 'Mixer' },
  Mastering: { ja: 'マスタリング', en: 'Mastering' },
  Instrumentalist: { ja: '演奏', en: 'Instrumentalist' },
  Vocalist: { ja: '歌唱', en: 'Vocalist' },
  VoiceManipulator: { ja: '調声', en: 'Voice manipulator' },
  Chorus: { ja: 'コーラス', en: 'Chorus' },
  Encoder: { ja: 'エンコード', en: 'Encoder' },
  Publisher: { ja: '投稿', en: 'Publisher' },
  Distributor: { ja: '配信', en: 'Distributor' },
  VocalDataProvider: { ja: '音源提供', en: 'Vocal data provider' },
};

/** Credit role ('Composer' → 作曲). Accepts VocaDB's comma-separated role lists ('Composer, Lyricist' → 作曲・作詞). */
export function artistRoleLabel(role: string, language: AppLanguage): string {
  const labels = [...new Set(role.split(',')
    .map(item => item.trim())
    .filter(Boolean)
    .map(item => ARTIST_ROLE_TEXT[item]?.[language] ?? ARTIST_ROLE_TEXT.Other[language]))];
  if (labels.length === 0) return ARTIST_ROLE_TEXT.Other[language];
  return labels.join(language === 'ja' ? '・' : ', ');
}

const VOCAL_ARTIST_TYPES = new Set(['Vocalist', 'OtherVocalist', 'CoverArtist']);

/** Producer ボカロP / Circle サークル / Band バンド / voice libraries and singers ボーカル / everything else アーティスト. */
export function artistTypeLabel(type: string, language: AppLanguage): string {
  const ja = language === 'ja';
  if (type === 'Producer') return ja ? 'ボカロP' : 'Producer';
  if (type === 'Circle') return ja ? 'サークル' : 'Circle';
  if (type === 'Band') return ja ? 'バンド' : 'Band';
  if (VOCAL_ARTIST_TYPES.has(type) || isVoiceSynthArtistType(type)) return ja ? 'ボーカル' : 'Vocalist';
  return ja ? 'アーティスト' : 'Artist';
}

/** Video kind: Original 公式 / Reprint 転載 / Other その他. */
export function pvKindLabel(pvType: 'Original' | 'Reprint' | 'Other' | string, language: AppLanguage): string {
  const ja = language === 'ja';
  if (pvType === 'Original') return ja ? '公式' : 'Official';
  if (pvType === 'Reprint') return ja ? '転載' : 'Reupload';
  return ja ? 'その他' : 'Other';
}

const SERVICE_TEXT: Record<string, { ja: string; en: string }> = {
  Youtube: { ja: 'YouTube', en: 'YouTube' },
  NicoNicoDouga: { ja: 'ニコニコ', en: 'Niconico' },
  SoundCloud: { ja: 'SoundCloud', en: 'SoundCloud' },
  Bilibili: { ja: 'Bilibili', en: 'Bilibili' },
  Vimeo: { ja: 'Vimeo', en: 'Vimeo' },
  Piapro: { ja: 'piapro', en: 'piapro' },
  Creofuga: { ja: 'creofuga', en: 'creofuga' },
  Bandcamp: { ja: 'Bandcamp', en: 'Bandcamp' },
  File: { ja: 'ファイル', en: 'File' },
  LocalFile: { ja: 'ローカルファイル', en: 'Local file' },
};

/** Youtube → YouTube / NicoNicoDouga → ニコニコ (Niconico). Unknown services are returned as they are. */
export function serviceLabel(service: string, language: AppLanguage): string {
  return SERVICE_TEXT[service]?.[language] ?? service;
}
