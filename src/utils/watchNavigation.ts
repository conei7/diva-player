export interface WatchUrlSyncState {
  requestedSongId: number | null;
  displayedSongId: number | null;
  playingSongId: number | null;
  loadingFromUrl: boolean;
}

/** Returns the playback song that may safely replace the current watch URL. */
export function watchUrlPlaybackTarget(state: WatchUrlSyncState): number | null {
  if (state.loadingFromUrl) return null;
  if (!state.requestedSongId || state.displayedSongId !== state.requestedSongId) return null;
  if (!state.playingSongId || state.playingSongId === state.requestedSongId) return null;
  return state.playingSongId;
}

/** Rejects a song response that completed after a newer URL request. */
export function isCurrentWatchSongRequest(
  requestGeneration: number,
  activeGeneration: number,
  requestedSongId: number,
  activeSongId: number | null,
): boolean {
  return requestGeneration === activeGeneration && requestedSongId === activeSongId;
}
