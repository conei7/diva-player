import type { Song } from '../../types/vocadb';
import { usePlayerStore } from '../../stores/playerStore';

/**
 * 「キューに追加」 for a playlist or the selected songs. With nothing playing there is no queue
 * to add to (it could not be seen or played), so the songs start in the mini player, like YouTube.
 */
export function addSongsToQueue(songs: Song[], queueTitle: string): void {
  if (songs.length === 0) return;
  const player = usePlayerStore.getState();
  if (player.currentSong) player.addManyToQueue(songs, 'manual');
  else player.setQueue(songs, 0, true, 'manual', queueTitle);
}
