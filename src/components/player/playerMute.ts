/**
 * Mute for the M shortcut (DESIGN_SPEC §6.2.2) and the mute badge on the video.
 *
 * Muting turns playerStore.volume down to 0 in memory only (setVolume would save the 0): the saved
 * volume is left as it was, so a reload never starts silently, and unmuting goes back to the volume
 * from before. Every embedded player follows playerStore.volume, so this works the same for YouTube,
 * Niconico and SoundCloud (the Bilibili player takes no volume from the app at all).
 *
 * YouTube (polled) and Niconico (messages) report their volume back to the app a few milliseconds
 * after each change. PlayerEmbed asks isVolumeHeldByMute() before applying such a report, so a late
 * report neither undoes the mute nor saves 0.
 */
import { create } from 'zustand';
import { DEFAULT_VOLUME, usePlayerStore } from '../../stores/playerStore';

/** Reports this soon after muting or unmuting can still carry the volume from before. */
export const MUTE_REPORT_SETTLE_MS = 1_500;

interface PlayerMuteState {
  /** Muted from the app: the volume is 0 in memory only. */
  muted: boolean;
  /** The volume unmuting goes back to. */
  volumeBeforeMute: number;
  /** When the app last muted or unmuted (Date.now()). */
  changedAt: number;
}

export const usePlayerMuteStore = create<PlayerMuteState>(() => ({
  muted: false,
  volumeBeforeMute: DEFAULT_VOLUME,
  changedAt: Number.NEGATIVE_INFINITY,
}));

/** Nothing can be heard: muted here, or the volume itself is 0. The video then shows the badge. */
export function isSilentVolume(volume: number): boolean {
  return !(volume > 0);
}

export function mutePlayer(now = Date.now()): void {
  const { volume } = usePlayerStore.getState();
  if (isSilentVolume(volume)) return;
  usePlayerMuteStore.setState({ muted: true, volumeBeforeMute: volume, changedAt: now });
  // Not setVolume(0): that would save the 0.
  usePlayerStore.setState({ volume: 0 });
}

/** Back to the volume from before the mute, or to the default volume when it was 0 to begin with. */
export function unmutePlayer(now = Date.now()): void {
  const { muted, volumeBeforeMute } = usePlayerMuteStore.getState();
  usePlayerMuteStore.setState({ muted: false, changedAt: now });
  const { volume, setVolume } = usePlayerStore.getState();
  if (muted && volumeBeforeMute > 0) setVolume(volumeBeforeMute);
  else if (isSilentVolume(volume)) setVolume(DEFAULT_VOLUME);
}

/** M: mutes, or unmutes when nothing can be heard. Returns true when the player is muted now. */
export function toggleMute(now = Date.now()): boolean {
  if (isSilentVolume(usePlayerStore.getState().volume)) {
    unmutePlayer(now);
    return false;
  }
  mutePlayer(now);
  return true;
}

/**
 * True while a volume reported by an embedded player must be left alone instead of applied (and
 * saved): while muted, and for a moment after muting or unmuting, when reports can still carry the
 * volume from before.
 */
export function isVolumeHeldByMute(now = Date.now()): boolean {
  const { muted, changedAt } = usePlayerMuteStore.getState();
  return muted || now - changedAt < MUTE_REPORT_SETTLE_MS;
}
