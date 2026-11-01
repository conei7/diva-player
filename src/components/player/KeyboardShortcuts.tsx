import { lazy, Suspense, useEffect } from 'react';
import { translateSourceText } from '../../i18n';
import { useLanguageStore } from '../../stores/languageStore';
import { selectCanGoNext } from '../../hooks/useCanGoNext';
import { usePlayerStore } from '../../stores/playerStore';
import { useProgressStore } from '../../stores/progressStore';
import { dismissToast, showToast } from '../../stores/toastStore';
import { useUiStore } from '../../stores/uiStore';
import { OverlayErrorBoundary } from '../layout/RouteErrorBoundary';
import { toggleMute } from './playerMute';
import { hasCommandModifier, isInteractiveTarget, isTextEntryTarget } from './playerUi';

const KeyboardShortcutsDialog = lazy(() => import('./KeyboardShortcutsDialog'));

const SEEK_STEP_SECONDS = 5;

/** The last M toast: pressing M again replaces it at once instead of queueing behind it. */
let muteToastId: string | null = null;

/** M has nothing to see on its own, so it always says what it did. */
function toggleMuteWithToast() {
  const language = useLanguageStore.getState().language;
  const message = toggleMute()
    ? translateSourceText(language, 'ミュートしました')
    : translateSourceText(language, 'ミュートを解除しました');
  if (muteToastId) dismissToast(muteToastId);
  muteToastId = showToast(message);
}

/**
 * Page-wide player shortcuts (DESIGN_SPEC §6.2.2): Space play / pause, ← → 5 seconds,
 * Shift + ← → previous / next song, M mute (in memory only, see playerMute.ts), ? the list.
 * Keys typed into controls (buttons, links, fields, ARIA widgets, dialogs, menus) and Alt / Ctrl / ⌘
 * combinations are left alone.
 */
export default function KeyboardShortcuts() {
  const open = useUiStore(state => state.keyboardShortcutsOpen);
  const setOpen = useUiStore(state => state.setKeyboardShortcutsOpen);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || event.isComposing || hasCommandModifier(event)) return;

      if (event.key === '?') {
        if (event.repeat || isTextEntryTarget(event.target)) return;
        event.preventDefault();
        useUiStore.getState().setKeyboardShortcutsOpen(true);
        return;
      }

      const player = usePlayerStore.getState();
      if (!player.currentSong || event.repeat || isInteractiveTarget(event.target)) return;

      if (event.code === 'Space') {
        event.preventDefault();
        if (player.isPlaying) player.pause();
        else player.resume();
        return;
      }

      if (event.key === 'm' || event.key === 'M') {
        if (event.shiftKey) return;
        event.preventDefault();
        toggleMuteWithToast();
        return;
      }

      if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
        event.preventDefault();
        const forward = event.key === 'ArrowRight';
        if (event.shiftKey) {
          // At the end of the queue next() would stop playback, so Shift+→ does nothing there (like 次の曲).
          if (forward) {
            if (selectCanGoNext(player)) player.next();
          } else player.previous();
          return;
        }
        const { progress, duration } = useProgressStore.getState();
        player.seekTo(forward
          ? Math.min(duration, progress + SEEK_STEP_SECONDS)
          : Math.max(0, progress - SEEK_STEP_SECONDS));
      }
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  if (!open) return null;
  // This sits outside every page boundary: a list whose code cannot be downloaded (a tab older than
  // the deploy) closes with 「表示できませんでした」 and 再読み込み instead of taking the app down.
  // The boundary is new on each opening, so a second try says so again (React.lazy keeps the failure).
  return (
    <Suspense fallback={null}>
      <OverlayErrorBoundary onError={() => setOpen(false)}>
        <KeyboardShortcutsDialog open onClose={() => setOpen(false)} />
      </OverlayErrorBoundary>
    </Suspense>
  );
}
