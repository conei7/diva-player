import { getGlobalFilterSettings } from '../stores/globalFilterStore';
import { useHistoryStore } from '../stores/historyStore';
import { useImplicitFeedbackStore } from '../stores/implicitFeedbackStore';
import { usePlayerStore } from '../stores/playerStore';
import { usePlaylistStore } from '../stores/playlistStore';
import { useRatingStore } from '../stores/ratingStore';
import { generateDigPlaylist, type DigGenerationResult } from './digPlaylist';

/** Generates an ephemeral discovery mix and sends it straight to the player queue. */
export async function playDiscoveryMix(): Promise<DigGenerationResult> {
  const result = await generateDigPlaylist({
    historyEntries: useHistoryStore.getState().entries,
    playlists: usePlaylistStore.getState().playlists,
    ratings: useRatingStore.getState().ratings,
    implicitFeedback: useImplicitFeedbackStore.getState().feedback,
    globalFilters: getGlobalFilterSettings(),
  });

  if (result.songs.length > 0) {
    usePlayerStore.getState().setQueue(result.songs, 0, true, 'discovery', '発掘ミックス');
  }
  return result;
}
