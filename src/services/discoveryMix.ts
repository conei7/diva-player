import { getGlobalFilterSettings } from '../stores/globalFilterStore';
import { useHistoryStore } from '../stores/historyStore';
import { useImplicitFeedbackStore } from '../stores/implicitFeedbackStore';
import { usePlayerStore } from '../stores/playerStore';
import { usePlaylistStore } from '../stores/playlistStore';
import { useRatingStore } from '../stores/ratingStore';
import { type AppLanguage } from '../stores/languageStore';
import { showToast } from '../stores/toastStore';
import { useUiStore } from '../stores/uiStore';
import { translate, translateSourceText } from '../i18n';
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

/** Both entry points use the same empty result and optional now-playing announcement. */
export async function playDiscoveryMixWithNotice(language: AppLanguage, announceSuccess: boolean): Promise<number> {
  const count = (await playDiscoveryMix()).songs.length;
  if (count === 0) {
    showToast(translate(language, 'discoveryEmpty'), {
      action: { label: translateSourceText(language, 'フィルター'), onAction: () => useUiStore.getState().openSettings('filter') },
    });
  } else if (announceSuccess) {
    const source = count === 1 ? '発掘ミックスを再生中（1曲）' : '発掘ミックスを再生中（{count}曲）';
    showToast(translateSourceText(language, source, { count }), {
      action: {
        label: translateSourceText(language, 'キュー'),
        onAction: () => {
          const player = usePlayerStore.getState();
          if (!player.queueDrawerOpen) player.toggleQueueDrawer();
        },
      },
    });
  }
  return count;
}
