import type { Song } from '../types/vocadb';
import type { SortKey } from '../stores/playlistStore';

function compareSongs(first: Song, second: Song, sortKey: SortKey): number {
  if (sortKey === 'name') return first.name.localeCompare(second.name, 'ja');
  if (sortKey === 'artist') return (first.artistString ?? '').localeCompare(second.artistString ?? '', 'ja');
  if (sortKey === 'publishDate') return (second.publishDate ?? '').localeCompare(first.publishDate ?? '');
  return 0;
}

/** 表示だけを並べ替え、プレイリストに保存された追加順は変更しない。 */
export function sortPlaylistSongs(songs: Song[], sortKey: SortKey): Song[] {
  const copy = [...songs];
  if (sortKey === 'addedOrder') return copy;
  return copy.sort((first, second) => compareSongs(first, second, sortKey));
}

/**
 * A row of a playlist: the song and its position in the saved order. Rows carry the
 * position so actions on the second copy of a duplicated song reach that copy.
 */
export interface PlaylistEntry {
  song: Song;
  index: number;
}

/** Same order as sortPlaylistSongs (stable), keeping each row's saved position. */
export function sortPlaylistEntries<T extends PlaylistEntry>(entries: T[], sortKey: SortKey): T[] {
  const copy = [...entries];
  if (sortKey === 'addedOrder') return copy;
  return copy.sort((first, second) => compareSongs(first.song, second.song, sortKey) || first.index - second.index);
}
