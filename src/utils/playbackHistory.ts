/**
 * A playback sequence of zero is created only while restoring the persisted
 * player queue. It is not a new user-initiated playback and must not create a
 * second history event when the site is opened again.
 */
export function shouldRecordPlayback(
  hasHydrated: boolean,
  hasCurrentSong: boolean,
  playbackSequence: number,
): boolean {
  return hasHydrated && hasCurrentSong && playbackSequence > 0;
}
