/**
 * Helpers shared by the music layout's player bar (640px and up) and the phone mini bar.
 */
import { usePlayerStore } from '../../../stores/playerStore';
import { dismissToast, showToast } from '../../../stores/toastStore';
import { toggleMute } from '../../player/playerMute';

type LoopMode = ReturnType<typeof usePlayerStore.getState>['loopMode'];

/** A disabled-looking button that still shows its tooltip (shuffle needs two songs), as in the mini player. */
export const SOFT_DISABLED_CLASS = 'aria-disabled:cursor-default aria-disabled:text-yt-text-disabled aria-disabled:hover:bg-transparent aria-disabled:active:bg-transparent';

/** 44px tap targets for the primary controls on phones. */
export const MOBILE_BUTTON_CLASS = 'size-11!';

/** The same three labels as the mini player and the queue header. */
export function loopModeLabel(loopMode: LoopMode, t: (source: string) => string): string {
  if (loopMode === 'all') return t('ループ: すべて');
  if (loopMode === 'one') return t('ループ: 1曲');
  return t('ループ: オフ');
}

/** The last mute toast: pressing the button again replaces it at once instead of queueing behind it. */
let muteToastId: string | null = null;

/** The bar's mute button says what it did, like the M shortcut. Returns true when the player is muted now. */
export function toggleMuteWithToast(t: (source: string) => string): boolean {
  const muted = toggleMute();
  if (muteToastId) dismissToast(muteToastId);
  muteToastId = showToast(muted ? t('ミュートしました') : t('ミュートを解除しました'));
  return muted;
}

/** The Bilibili player takes no volume from the app (see playerMute.ts). */
export function ignoresAppVolume(service: string | undefined): boolean {
  return service === 'Bilibili';
}
