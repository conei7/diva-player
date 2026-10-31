import { useTranslateSourceText } from '../../../i18n';
import { usePlayerStore } from '../../../stores/playerStore';
import { showToast } from '../../../stores/toastStore';
import { useUiStore } from '../../../stores/uiStore';
import { songShareUrl } from '../../../utils/routes';
import SleepTimerMenuItems from '../../player/SleepTimerMenuItems';
import { copyTextToClipboard } from '../../player/playerUi';
import IconButton from '../../ui/IconButton';
import Menu, { MenuDivider, MenuItem } from '../../ui/Menu';
import { CloseIcon, LinkIcon, MoreVertIcon, PlaylistAddIcon } from '../../ui/icons';

/**
 * The player bar's ⋮: the sleep timer, リンクをコピー and キューをプレイリストに保存 as in the mini player,
 * and プレイヤーを閉じる (the bar has no ✕ of its own). The bar is at the bottom of the window, so the
 * menu opens upwards (Menu flips when there is no room below).
 */
export default function PlayerBarMenu() {
  const t = useTranslateSourceText();
  const songId = usePlayerStore(state => state.currentSong?.id ?? null);
  const queue = usePlayerStore(state => state.queue);
  const queueIndex = usePlayerStore(state => state.queueIndex);
  const closePlayer = usePlayerStore(state => state.closePlayer);

  const copyLink = () => {
    if (songId === null) return;
    void copyTextToClipboard(songShareUrl(songId)).then(copied => {
      showToast(copied ? t('リンクをコピーしました') : t('リンクをコピーできませんでした'));
    });
  };
  const saveQueue = () => {
    useUiStore.getState().openSaveToPlaylist(queue, { source: 'queue', queueIndex });
  };

  return (
    <Menu
      align="end"
      width={264}
      trigger={(
        <IconButton
          label={t('その他の操作')}
          icon={<MoreVertIcon />}
          disabled={songId === null}
          tooltipPlacement="left"
          data-testid="music-player-more"
        />
      )}
    >
      <SleepTimerMenuItems />
      <MenuDivider />
      <MenuItem icon={<LinkIcon />} onSelect={copyLink}>{t('リンクをコピー')}</MenuItem>
      <MenuItem icon={<PlaylistAddIcon />} disabled={queue.length === 0} onSelect={saveQueue}>
        {t('キューをプレイリストに保存')}
      </MenuItem>
      <MenuDivider />
      <MenuItem icon={<CloseIcon />} onSelect={closePlayer}>{t('プレイヤーを閉じる')}</MenuItem>
    </Menu>
  );
}
