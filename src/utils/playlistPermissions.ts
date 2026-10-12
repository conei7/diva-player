import type { Playlist } from '../types/vocadb';

type PlaylistSource = Pick<Playlist, 'smartRule' | 'youtubeSync' | 'nicoSync'>;

/** A playlist that mirrors a YouTube or Niconico list. Its songs follow the source. */
export function isSyncedPlaylist(playlist: Pick<Playlist, 'youtubeSync' | 'nicoSync'>): boolean {
  return playlist.youtubeSync?.enabled === true || playlist.nicoSync?.enabled === true;
}

/**
 * Whether the songs can be changed by hand (add, remove, reorder, remove duplicates).
 * Smart playlists are rebuilt from their rules and synced playlists follow their source,
 * so their song lists are read-only.
 */
export function isPlaylistEditable(playlist: PlaylistSource): boolean {
  return !playlist.smartRule && !isSyncedPlaylist(playlist);
}

/**
 * Whether the name, description, image and folder can be changed, and the playlist deleted.
 * Every playlist except the built-in ones (後で聴く) — synced playlists too.
 */
export function canEditPlaylistDetails(playlist: Pick<Playlist, 'isPinned'>): boolean {
  return !playlist.isPinned;
}
