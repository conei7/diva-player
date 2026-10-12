import { useEffect } from 'react';
import { translateSourceText } from '../../i18n';
import { usePlayerStore } from '../../stores/playerStore';
import { useLanguageStore } from '../../stores/languageStore';
import { useSleepTimerStore } from '../../stores/sleepTimerStore';
import { showToast } from '../../stores/toastStore';
import { recordSleepTimerChoice } from './playerUi';

/** Timers are clamped to this (the largest delay setTimeout accepts). */
const MAX_TIMEOUT_MS = 2_147_483_647;

/**
 * SleepTimerWatcher (DESIGN_SPEC §6.2.3): no UI, always mounted inside GlobalPlayer.
 * Pauses playback when sleepTimerStore's deadline passes, clears the timer and says so in a toast.
 * Throttled background timers can fire late, so the deadline is checked again whenever the tab
 * becomes visible or the device wakes up.
 */
export default function SleepTimerWatcher() {
  const until = useSleepTimerStore(state => state.until);

  // Remember which option started each new deadline (any menu may start it).
  useEffect(() => useSleepTimerStore.subscribe((state, prev) => {
    if (state.until !== prev.until) recordSleepTimerChoice(state.until);
  }), []);

  useEffect(() => {
    if (until === null) return undefined;
    let timer: number | undefined;
    const check = () => {
      if (useSleepTimerStore.getState().until !== until) return;
      if (Date.now() < until) {
        window.clearTimeout(timer);
        timer = window.setTimeout(check, Math.min(MAX_TIMEOUT_MS, until - Date.now()));
        return;
      }
      const { isPlaying, pause } = usePlayerStore.getState();
      useSleepTimerStore.getState().clear();
      if (isPlaying) {
        pause();
        showToast(translateSourceText(useLanguageStore.getState().language, 'スリープタイマーで停止しました'));
      }
    };
    check();
    document.addEventListener('visibilitychange', check);
    document.addEventListener('resume', check);
    window.addEventListener('focus', check);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', check);
      document.removeEventListener('resume', check);
      window.removeEventListener('focus', check);
    };
  }, [until]);

  return null;
}

// The ⋮ menu group (SleepTimerMenuItems) lives in its own module so this always-mounted watcher
// does not bring the Menu code into the initial JavaScript.
