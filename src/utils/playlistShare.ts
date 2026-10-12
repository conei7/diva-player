import type { Playlist, Song } from '../types/vocadb';
import { absoluteAppUrl, playlistsPath } from './routes';

const SHARE_KIND = 'diva-player-playlist-share';
/** v1 links carried every song (about 2KB each); v2 links carry only the song ids. */
const SHARE_VERSION = 2;
const LEGACY_SHARE_VERSION = 1;
/** Longer links are refused by servers (HTTP 431 from about 16KB) and get cut by chat apps. */
export const MAX_PLAYLIST_SHARE_URL_LENGTH = 8_000;
const MAX_SHARED_SONG_IDS = 5_000;

export interface PlaylistSharePayload {
  kind: typeof SHARE_KIND;
  version: typeof SHARE_VERSION;
  name: string;
  description?: string;
  coverArtUrl?: string;
  /** The receiver fetches these songs when the link is opened. */
  songIds: number[];
}

/** A decoded share link. Old (v1) links still carry the songs themselves. */
export interface SharedPlaylist {
  name: string;
  description?: string;
  coverArtUrl?: string;
  songIds: number[];
  /** Only in v1 links. */
  songs?: Song[];
}

function toBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  bytes.forEach(byte => { binary += String.fromCharCode(byte); });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64Url(value: string): string {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4);
  const binary = atob(padded);
  return new TextDecoder().decode(Uint8Array.from(binary, char => char.charCodeAt(0)));
}

function isSongId(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) > 0;
}

/** `name` is the name to share (the shown name, e.g. 後で聴く in the UI language). */
export function createPlaylistSharePayload(playlist: Playlist, name = playlist.name): PlaylistSharePayload {
  return {
    kind: SHARE_KIND,
    version: SHARE_VERSION,
    name,
    description: playlist.description,
    coverArtUrl: playlist.coverArtUrl,
    songIds: playlist.songs.map(song => song.id),
  };
}

export function encodePlaylistShare(playlist: Playlist, name?: string): string {
  return toBase64Url(JSON.stringify(createPlaylistSharePayload(playlist, name)));
}

export function decodePlaylistShare(encoded: string): SharedPlaylist | null {
  try {
    const value = JSON.parse(fromBase64Url(encoded)) as Record<string, unknown>;
    if (value.kind !== SHARE_KIND || typeof value.name !== 'string') return null;
    const details = {
      name: value.name.slice(0, 200),
      description: typeof value.description === 'string' ? value.description.slice(0, 2_000) : undefined,
      coverArtUrl: typeof value.coverArtUrl === 'string' ? value.coverArtUrl : undefined,
    };
    if (value.version === SHARE_VERSION) {
      const songIds = value.songIds;
      if (!Array.isArray(songIds) || songIds.length > MAX_SHARED_SONG_IDS || !songIds.every(isSongId)) return null;
      return { ...details, songIds: songIds as number[] };
    }
    if (value.version === LEGACY_SHARE_VERSION && Array.isArray(value.songs)) {
      const songs = value.songs.filter((song: unknown): song is Song => Boolean(song)
        && typeof song === 'object'
        && isSongId((song as Song).id)
        && typeof (song as Song).name === 'string');
      if (songs.length !== value.songs.length) return null;
      return { ...details, songIds: songs.map(song => song.id), songs };
    }
    return null;
  } catch {
    return null;
  }
}

function shareUrlFor(payload: PlaylistSharePayload): string {
  const query = new URLSearchParams({ share: toBase64Url(JSON.stringify(payload)) });
  return absoluteAppUrl(`${playlistsPath()}?${query.toString()}`);
}

/**
 * Link that opens /playlists?share=… under the app's base path (e.g. /diva-player/).
 * When the description or the cover would make it too long they are left out; null when even
 * the song ids alone do not fit (share the JSON export instead).
 */
export function createPlaylistShareUrl(playlist: Playlist, options: { name?: string } = {}): string | null {
  const payload = createPlaylistSharePayload(playlist, options.name);
  const full = shareUrlFor(payload);
  if (full.length <= MAX_PLAYLIST_SHARE_URL_LENGTH) return full;
  const songsOnly = shareUrlFor({ ...payload, description: undefined, coverArtUrl: undefined });
  return songsOnly.length <= MAX_PLAYLIST_SHARE_URL_LENGTH ? songsOnly : null;
}

/** The shared songs in the shared order (songs that no longer exist are left out). */
export function orderSharedSongs(songIds: number[], songs: Song[]): Song[] {
  const byId = new Map(songs.map(song => [song.id, song]));
  return songIds.map(id => byId.get(id)).filter((song): song is Song => song !== undefined);
}
