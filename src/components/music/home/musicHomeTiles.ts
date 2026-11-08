/**
 * Pure helpers of the music layout's Home header (MusicHome, QuickTiles): the greeting and the order of
 * the quick tiles.
 */
import { WATCH_LATER_ID } from '../../../stores/playlistStore';
import type { Playlist } from '../../../types/vocadb';
import { playlistPath } from '../../../utils/routes';
import { NAV_ITEMS } from '../../layout/navItems';
import type { NavId } from '../../layout/navItems';

/** The greeting over the quick tiles, by the hour when Home opened (5–10 morning, 11–17 day, else evening). */
export function greetingFor(hour: number): 'morning' | 'day' | 'evening' {
  if (hour >= 5 && hour < 11) return 'morning';
  if (hour >= 11 && hour < 18) return 'day';
  return 'evening';
}

/** Tiles shown: two rows of four on a wide page, four rows of two otherwise. */
export const QUICK_TILE_COUNT = 8;
const QUICK_PLAYLIST_LIMIT = 4;
/** After 評価した曲, 後で聴く and the playlists, destinations fill the remaining tiles in this order. */
const FILL_DESTINATIONS: readonly NavId[] = ['history', 'soundMap', 'chorus', 'favoriteProducers', 'knowledgeMap', 'reports'];

export interface QuickTile {
  key: string;
  to: string;
  label: string;
  /** The tile's playlist (後で聴く or one of the user's): its cover, and its songs for ▶. */
  playlist?: Playlist;
  /** A destination's colour tile instead of a cover. */
  destination?: NavId;
  /** ▶ plays the playlist from the first song (only a playlist with songs). */
  playable: boolean;
}

/**
 * The quick tiles' order: 評価した曲, 後で聴く, up to four of the user's playlists in the library order
 * (the same as the あなたのプレイリスト shelf), then destinations until there are eight. The count never
 * changes once the playlists arrive, so nothing below the tiles moves.
 */
export function buildQuickTiles(
  playlists: readonly Playlist[],
  ordered: readonly Playlist[],
  labels: Partial<Record<NavId, string>>,
  playlistName: (playlist: Playlist) => string,
): QuickTile[] {
  const destination = (id: NavId): QuickTile => ({
    key: id, to: NAV_ITEMS[id].to, label: labels[id] ?? id, destination: id, playable: false,
  });
  const watchLater = playlists.find(playlist => playlist.id === WATCH_LATER_ID);
  const tiles: QuickTile[] = [
    destination('ratings'),
    { ...destination('watchLater'), playlist: watchLater, playable: (watchLater?.songs.length ?? 0) > 0 },
  ];
  for (const playlist of ordered) {
    if (tiles.length >= 2 + QUICK_PLAYLIST_LIMIT) break;
    if (playlist.id === WATCH_LATER_ID) continue;
    tiles.push({
      key: `playlist:${playlist.id}`,
      to: playlistPath(playlist.id),
      label: playlistName(playlist),
      playlist,
      playable: playlist.songs.length > 0,
    });
  }
  for (const id of FILL_DESTINATIONS) {
    if (tiles.length >= QUICK_TILE_COUNT) break;
    tiles.push(destination(id));
  }
  return tiles.slice(0, QUICK_TILE_COUNT);
}
