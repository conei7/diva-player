import type { Song } from '../types/vocadb';
import type { SortKey } from '../stores/playlistStore';

/** 表示だけを並べ替え、プレイリストに保存された追加順は変更しない。 */
export function sortPlaylistSongs(songs: Song[], sortKey: SortKey): Song[] {
  const copy = [...songs];
  if (sortKey === 'addedOrder') return copy;
  if (sortKey === 'name') return copy.sort((first, second) => first.name.localeCompare(second.name, 'ja'));
  if (sortKey === 'artist') {
    return copy.sort((first, second) => (first.artistString ?? '').localeCompare(second.artistString ?? '', 'ja'));
  }
  return copy.sort((first, second) => (second.publishDate ?? '').localeCompare(first.publishDate ?? ''));
}
