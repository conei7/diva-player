import { useSyncExternalStore } from 'react';
import { getPlaybackOwnership } from '../../../services/playbackOwnership';
import type { PlaybackOwnershipState } from '../../../services/playbackOwnership';
import { usePlayerStore } from '../../../stores/playerStore';

/**
 * Whether this tab shows the video, decided exactly like GlobalPlayer: the iframe is docked over the
 * 再生中 panel's slot only while this tab owns playback (or nobody does yet and it is playing).
 * Otherwise (another tab plays, or a restored queue is paused) the slot shows the artwork.
 */
export function useLocalPlayback(): { ownership: PlaybackOwnershipState; hasLocalPlayback: boolean } {
  const isPlaying = usePlayerStore(state => state.isPlaying);
  const playbackOwnership = getPlaybackOwnership();
  const ownership = useSyncExternalStore(
    playbackOwnership.subscribe,
    playbackOwnership.getState,
    playbackOwnership.getState,
  );
  return {
    ownership,
    hasLocalPlayback: ownership === 'local' || (ownership === 'none' && isPlaying),
  };
}
