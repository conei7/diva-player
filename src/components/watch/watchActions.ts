/**
 * Song actions shared by the watch page, the playing-list panel, the queue drawer and the players.
 * Each one updates the stores and reports the result with the single toast (DESIGN_SPEC §4.8).
 * Messages are passed through the caller's source-text translator.
 */
import type { Song } from '../../types/vocadb';
import type { SourceTextTranslator } from '../../utils/displayNames';
import { usePlayerStore } from '../../stores/playerStore';
import type { ClosedPlayer, RemovedQueueItem } from '../../stores/playerStore';
import { useProgressStore } from '../../stores/progressStore';
import { useAutoPlaySessionStore } from '../../stores/autoPlaySessionStore';
import { usePlaylistStore, WATCH_LATER_ID } from '../../stores/playlistStore';
import { useHiddenSongStore } from '../../stores/hiddenSongStore';
import { useImplicitFeedbackStore } from '../../stores/implicitFeedbackStore';
import { useUiStore } from '../../stores/uiStore';
import { showToast, TOAST_ACTION_DURATION_MS, useToastStore } from '../../stores/toastStore';
import { songShareUrl } from '../../utils/routes';

/** Clipboard API first, then the selection-based fallback (older browsers, denied permission). */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall back below.
  }
  if (typeof document === 'undefined') return false;
  const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.top = '0';
  textarea.style.left = '0';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  try {
    textarea.select();
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    textarea.remove();
    previousFocus?.focus({ preventScroll: true });
  }
}

/** Copies the canonical DIVA song link (/watch?v=ID, never the current URL with its extra parameters). */
export function shareSong(song: Pick<Song, 'id'>, t: SourceTextTranslator): void {
  void copyText(songShareUrl(song.id)).then(copied => {
    showToast(copied ? t('リンクをコピーしました') : t('リンクをコピーできませんでした'));
  });
}

export function isInWatchLater(songId: number): boolean {
  return usePlaylistStore.getState().playlists
    .find(playlist => playlist.id === WATCH_LATER_ID)?.songs.some(song => song.id === songId) ?? false;
}

/** 後で聴く: save (toast with 変更 = the save dialog) or remove (toast with 元に戻す). */
export async function toggleWatchLater(song: Song, t: SourceTextTranslator): Promise<void> {
  try {
    const store = usePlaylistStore.getState();
    const watchLater = store.playlists.find(playlist => playlist.id === WATCH_LATER_ID);
    const indexes = watchLater?.songs.flatMap((item, index) => (item.id === song.id ? [index] : [])) ?? [];
    if (indexes.length > 0) {
      const snapshot = (await store.removeSongs(WATCH_LATER_ID, indexes));
      if (!snapshot) return;
      showToast(t('後で聴くから削除しました'), {
        action: {
          label: t('元に戻す'),
          onAction: async () => {
            try {
              (await usePlaylistStore.getState().restoreRemovedSongs(snapshot));
            } catch {
              // The playlist store reports persistence errors itself.
            }
          },
        },
      });
      return;
    }
    // Layout loads playlists asynchronously; make sure the system playlist exists.
    if (!watchLater) (await store.getOrCreateWatchLater());
    const added = (await usePlaylistStore.getState().toggleSongInPlaylist(WATCH_LATER_ID, song));
    if (!added) return;
    showToast(t('後で聴くに保存しました'), {
      action: { label: t('変更'), onAction: () => useUiStore.getState().openSaveToPlaylist(song) },
    });
  } catch {
    // The playlist store reports persistence errors itself; don't claim success.
  }
}

function restoreRemovedQueueItem(removed: RemovedQueueItem, wasCurrent: boolean): void {
  const store = usePlayerStore.getState();
  const insertAt = Math.max(0, Math.min(removed.index, store.queue.length));
  store.restoreQueueItem(removed);
  // Going back to the song that was playing (it moved on to the next one when it was hidden).
  if (wasCurrent) usePlayerStore.getState().jumpToIndex(insertAt);
}

/**
 * 表示しない. When the song is in the queue (`queueIndex`, or the playing song) it also leaves the
 * queue, so playback moves on to the next song. 元に戻す restores the song, its queue position
 * and — when it was playing — playback of it.
 */
export function hideSongWithUndo(song: Song, t: SourceTextTranslator, queueIndex?: number): void {
  useHiddenSongStore.getState().hideSong(song);
  const player = usePlayerStore.getState();
  const index = queueIndex ?? (player.queue[player.queueIndex]?.id === song.id ? player.queueIndex : -1);
  const wasCurrent = player.currentSong?.id === song.id && (index < 0 || index === player.queueIndex);
  let removed: RemovedQueueItem | null = null;
  if (index >= 0 && player.queue[index]?.id === song.id) {
    removed = player.removeFromQueue(index);
  } else if (wasCurrent) {
    player.closePlayer();
  }
  showToast(t('表示しない曲に追加しました'), {
    action: {
      label: t('元に戻す'),
      onAction: () => {
        useHiddenSongStore.getState().restoreSong(song.id);
        if (removed) restoreRemovedQueueItem(removed, wasCurrent);
      },
    },
  });
}

/**
 * プレイヤーを閉じる (the mini players' ✕, the player bar's ⋮) with 元に戻す: one mis-tap next to
 * 次の曲 must not throw away a long queue. Undo brings back the queue, its position and title, the
 * mix seed and the playback position, unless another song was started in the meantime; the same
 * play then goes on (no second history play, no skip). A queue that is still being restored (only
 * partly loaded) closes without undo, as before.
 */
export function closePlayerWithUndo(t: SourceTextTranslator): void {
  const player = usePlayerStore.getState();
  const { currentSong } = player;
  if (!currentSong || player.queue.length === 0 || player.restoringQueueWindow) {
    player.closePlayer();
    return;
  }
  const closed: ClosedPlayer = {
    queue: player.queue,
    queueIndex: player.queueIndex,
    queueSources: player.queueSources,
    queueTitle: player.queueTitle,
    originalQueue: player.originalQueue,
    shuffleEnabled: player.shuffleEnabled,
    rootSeed: player.rootSeed,
    queueContinuation: player.queueContinuation,
    currentSong,
    currentPV: player.currentPV,
    currentPlaybackSource: player.currentPlaybackSource,
    playbackSequence: player.playbackSequence,
    isPlaying: player.isPlaying,
    // Still the closed song's position: PlayerTracker resets it only after the close.
    progress: useProgressStore.getState().progress,
    autoPlaySession: useAutoPlaySessionStore.getState().session,
  };
  player.closePlayer({ undoable: true });
  const toastId = showToast(t('プレイヤーを閉じました'), {
    action: { label: t('元に戻す'), onAction: () => usePlayerStore.getState().restoreClosedPlayer(closed) },
  });
  // The closed play counts (skip feedback, history details) once 元に戻す is gone: the toast's
  // own lifetime, which pauses while it is hovered or focused, not a fixed time.
  const unsubscribe = useToastStore.subscribe(({ toasts }) => {
    if (toasts.some(toast => toast.id === toastId)) return;
    unsubscribe();
    // A microtask later: ToastHost removes the toast just before it runs 元に戻す, which must
    // still find the close pending (and then clears it itself).
    queueMicrotask(() => {
      if (usePlayerStore.getState().undoableCloseSequence === closed.playbackSequence) {
        usePlayerStore.setState({ undoableCloseSequence: null });
      }
    });
  });
}

/** キューから削除 with 元に戻す. The removal counts as implicit feedback only when it is not undone. */
export function removeQueueItemWithUndo(index: number, t: SourceTextTranslator): void {
  const removed = usePlayerStore.getState().removeFromQueue(index);
  if (!removed) return;
  const timer = setTimeout(() => {
    useImplicitFeedbackStore.getState().recordQueueRemove(removed.song.id);
  }, TOAST_ACTION_DURATION_MS);
  showToast(t('キューから削除しました'), {
    action: {
      label: t('元に戻す'),
      onAction: () => {
        clearTimeout(timer);
        usePlayerStore.getState().restoreQueueItem(removed);
      },
    },
  });
}
