import type { Playlist, Song } from '../types/vocadb';

const SHARE_KIND = 'diva-player-playlist-share';
const SHARE_VERSION = 1;

export interface PlaylistSharePayload {
  kind: typeof SHARE_KIND;
  version: typeof SHARE_VERSION;
  name: string;
  description?: string;
  coverArtUrl?: string;
  songs: Song[];
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

function slimSong(song: Song): Song {
  return {
    ...song,
    artists: undefined,
    tags: undefined,
    pvs: song.pvs?.map(pv => ({ ...pv, description: undefined })),
  };
}

export function createPlaylistSharePayload(playlist: Playlist): PlaylistSharePayload {
  return {
    kind: SHARE_KIND,
    version: SHARE_VERSION,
    name: playlist.name,
    description: playlist.description,
    coverArtUrl: playlist.coverArtUrl,
    songs: playlist.songs.map(slimSong),
  };
}

export function encodePlaylistShare(playlist: Playlist): string {
  return toBase64Url(JSON.stringify(createPlaylistSharePayload(playlist)));
}

export function decodePlaylistShare(encoded: string): PlaylistSharePayload | null {
  try {
    const value = JSON.parse(fromBase64Url(encoded)) as Partial<PlaylistSharePayload>;
    if (value.kind !== SHARE_KIND || value.version !== SHARE_VERSION || typeof value.name !== 'string' || !Array.isArray(value.songs)) return null;
    const songs = value.songs.filter(song => song && typeof song === 'object' && Number.isInteger(song.id) && song.id > 0 && typeof song.name === 'string') as Song[];
    if (songs.length !== value.songs.length) return null;
    return {
      kind: SHARE_KIND,
      version: SHARE_VERSION,
      name: value.name.slice(0, 200),
      description: typeof value.description === 'string' ? value.description.slice(0, 2_000) : undefined,
      coverArtUrl: typeof value.coverArtUrl === 'string' ? value.coverArtUrl : undefined,
      songs,
    };
  } catch {
    return null;
  }
}

export function createPlaylistShareUrl(playlist: Playlist): string {
  const url = new URL('/playlists', window.location.origin);
  url.searchParams.set('share', encodePlaylistShare(playlist));
  return url.toString();
}
