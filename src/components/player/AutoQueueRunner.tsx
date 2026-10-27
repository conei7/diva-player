import { useAutoQueue } from '../../hooks/useAutoQueue';
import { usePlayerStore } from '../../stores/playerStore';
import { useHistoryStore } from '../../stores/historyStore';
import { useRatingStore } from '../../stores/ratingStore';
import { usePlaylistStore } from '../../stores/playlistStore';
import { useImplicitFeedbackStore } from '../../stores/implicitFeedbackStore';
import { useAutoPlaySessionStore } from '../../stores/autoPlaySessionStore';

/**
 * Autoplay: adds recommended songs before the queue runs out (useAutoQueue). App lazy-loads this
 * right after the first render so the recommendation code stays out of the initial JavaScript
 * (DESIGN_SPEC §1-12). The hook and its inputs are the same as when PlayerTracker called it.
 */
export default function AutoQueueRunner() {
  const queueRestoring = usePlayerStore(s => s.queueRestoring);
  const currentSong = usePlayerStore(s => s.currentSong);
  const playbackSequence = usePlayerStore(s => s.playbackSequence);
  const rootSeed = usePlayerStore(s => s.rootSeed);
  const queue = usePlayerStore(s => s.queue);
  const queueIndex = usePlayerStore(s => s.queueIndex);
  const addManyToQueue = usePlayerStore(s => s.addManyToQueue);
  const historyEntries = useHistoryStore(s => s.entries);
  const ratings = useRatingStore(s => s.ratings);
  const playlists = usePlaylistStore(s => s.playlists);
  const playlistsHydrated = usePlaylistStore(s => s.hasHydrated);
  const implicitFeedback = useImplicitFeedbackStore(s => s.feedback);
  const autoPlaySession = useAutoPlaySessionStore(s => s.session);

  useAutoQueue({
    currentSong: queueRestoring || !playlistsHydrated ? null : currentSong,
    playbackSequence,
    rootSeed,
    queue,
    queueIndex,
    historyEntries,
    ratings,
    playlists,
    implicitFeedback,
    autoPlayedCount: autoPlaySession?.autoPlayedCount ?? 0,
    adaptation: {
      autoCompletedCount: autoPlaySession?.autoCompletedCount ?? 0,
      autoSkippedCount: autoPlaySession?.autoSkippedCount ?? 0,
      consecutiveSkips: autoPlaySession?.consecutiveSkips ?? 0,
    },
    addManyToQueue,
  });

  return null;
}
