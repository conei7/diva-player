import { Children, isValidElement, useState } from 'react';
import type { ReactNode } from 'react';
import type { Song } from '../../types/vocadb';
import { useTranslateSourceText } from '../../i18n';
import { usePlayerStore } from '../../stores/playerStore';
import { usePlaylistStore, WATCH_LATER_ID } from '../../stores/playlistStore';
import { useUiStore } from '../../stores/uiStore';
import { useHiddenSongStore } from '../../stores/hiddenSongStore';
import { showToast } from '../../stores/toastStore';
import { isPlayablePV } from '../../utils/playablePV';
import { songShareUrl } from '../../utils/routes';
import IconButton from './IconButton';
import Menu, { MenuDivider, MenuItem } from './Menu';
import {
  ClockIcon,
  EyeIcon,
  EyeOffIcon,
  MoreVertIcon,
  OpenInNewIcon,
  PlaylistAddIcon,
  QueueMusicIcon,
  ShareIcon,
} from './icons';
import { cx } from './overlay';

export type SongActionKey = 'queue' | 'watchLater' | 'save' | 'share' | 'openVocaDb' | 'hide';

export interface SongActionsMenuProps {
  song: Song;
  /** Default ['queue', 'watchLater', 'save', 'share', 'hide']. Items always render in the canonical order. */
  include?: SongActionKey[];
  /** Screen-specific items: after the divider, before 「表示しない」. */
  extraItems?: ReactNode;
  /** Last items, after another divider (e.g. 「「{name}」から削除」). */
  footerItems?: ReactNode;
  /** Called after an action ran (exposure logging etc.). */
  onAction?: (key: SongActionKey) => void;
  /** Replaces the default 「表示しない」 (e.g. the song that is playing). Not used for 「再表示」. */
  onHide?: () => void;
  /** Default false: on mouse devices the ⋮ only shows on hover / focus / while open (.reveal-on-hover). */
  alwaysVisible?: boolean;
  /** Trigger 32 / 40px. Default 'md'. */
  size?: 'sm' | 'md';
  /** Default 「「{title}」のその他の操作」. */
  label?: string;
}

const DEFAULT_ACTIONS: SongActionKey[] = ['queue', 'watchLater', 'save', 'share', 'hide'];
/** Items above the first divider. */
const BASE_ACTIONS: SongActionKey[] = ['queue', 'watchLater', 'save', 'share', 'openVocaDb'];

function hasMenuContent(node: ReactNode): boolean {
  return Children.toArray(node).some(child => !isValidElement(child) || child.type !== MenuDivider);
}

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall back to the selection-based copy below (e.g. permission denied).
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

export default function SongActionsMenu({
  song,
  include = DEFAULT_ACTIONS,
  extraItems,
  footerItems,
  onAction,
  onHide,
  alwaysVisible = false,
  size = 'md',
  label,
}: SongActionsMenuProps) {
  const t = useTranslateSourceText();
  const [open, setOpen] = useState(false);
  const menuLabel = label ?? t('「{title}」のその他の操作', { title: song.name });

  return (
    // Keeps the trigger's click from reaching a clickable card or row around it.
    <div
      className={cx('flex shrink-0', !alwaysVisible && 'reveal-on-hover')}
      data-open={open ? 'true' : undefined}
      onClick={event => event.stopPropagation()}
    >
      <Menu
        trigger={(
          <IconButton
            label={menuLabel}
            icon={<MoreVertIcon />}
            size={size}
          />
        )}
        align="end"
        label={menuLabel}
        open={open}
        onOpenChange={setOpen}
      >
        {open && (
          <SongActionsMenuItems
            song={song}
            include={include}
            extraItems={extraItems}
            footerItems={footerItems}
            onAction={onAction}
            onHide={onHide}
          />
        )}
      </Menu>
    </div>
  );
}

interface SongActionsMenuItemsProps {
  song: Song;
  include: SongActionKey[];
  extraItems?: ReactNode;
  footerItems?: ReactNode;
  onAction?: (key: SongActionKey) => void;
  onHide?: () => void;
}

/** Rendered only while the menu is open so closed menus don't subscribe to the stores. */
function SongActionsMenuItems({ song, include, extraItems, footerItems, onAction, onHide }: SongActionsMenuItemsProps) {
  const t = useTranslateSourceText();
  const songKey = String(song.id);
  const isInWatchLater = usePlaylistStore(state => state.playlists
    .find(playlist => playlist.id === WATCH_LATER_ID)?.songs.some(item => item.id === song.id) ?? false);
  const isHidden = useHiddenSongStore(state => Boolean(state.hiddenSongs[songKey]));
  const canQueue = song.pvs?.some(pv => isPlayablePV(pv)) ?? false;
  const has = (key: SongActionKey) => include.includes(key);

  const addToQueue = () => {
    const player = usePlayerStore.getState();
    // Nothing is playing: an added song would sit in an invisible queue, so start it instead
    // (the mini player appears), like YouTube's "Add to queue" with no video playing.
    if (player.currentSong) player.addToQueue(song);
    else player.setQueue([song], 0);
    showToast(t('キューに追加しました'));
    onAction?.('queue');
  };

  const toggleWatchLater = () => {
    try {
      const store = usePlaylistStore.getState();
      const watchLater = store.playlists.find(playlist => playlist.id === WATCH_LATER_ID);
      const indexes = watchLater?.songs.flatMap((item, index) => (item.id === song.id ? [index] : [])) ?? [];
      if (indexes.length > 0) {
        const snapshot = store.removeSongs(WATCH_LATER_ID, indexes);
        if (!snapshot) return;
        showToast(t('後で聴くから削除しました'), {
          action: {
            label: t('元に戻す'),
            onAction: () => {
              try {
                usePlaylistStore.getState().restoreRemovedSongs(snapshot);
              } catch {
                // The store reports persistence errors itself.
              }
            },
          },
        });
      } else {
        if (!watchLater) store.getOrCreateWatchLater();
        const added = usePlaylistStore.getState().toggleSongInPlaylist(WATCH_LATER_ID, song);
        if (!added) return;
        showToast(t('後で聴くに保存しました'), {
          action: { label: t('変更'), onAction: () => useUiStore.getState().openSaveToPlaylist(song) },
        });
      }
      onAction?.('watchLater');
    } catch {
      // The playlist store reports persistence errors itself; don't claim success.
    }
  };

  const saveToPlaylist = () => {
    useUiStore.getState().openSaveToPlaylist(song);
    onAction?.('save');
  };

  const share = () => {
    onAction?.('share');
    void copyToClipboard(songShareUrl(song.id)).then(copied => {
      showToast(copied ? t('リンクをコピーしました') : t('リンクをコピーできませんでした'));
    });
  };

  const toggleHidden = () => {
    const hiddenStore = useHiddenSongStore.getState();
    const record = hiddenStore.hiddenSongs[songKey];
    if (record) {
      hiddenStore.restoreSong(song.id);
      showToast(t('再表示しました'), {
        action: {
          label: t('元に戻す'),
          onAction: () => useHiddenSongStore.setState(state => ({
            hiddenSongs: { ...state.hiddenSongs, [songKey]: record },
          })),
        },
      });
    } else if (onHide) {
      onHide();
    } else {
      hiddenStore.hideSong(song);
      showToast(t('表示しない曲に追加しました'), {
        action: { label: t('元に戻す'), onAction: () => useHiddenSongStore.getState().restoreSong(song.id) },
      });
    }
    onAction?.('hide');
  };

  const showExtra = hasMenuContent(extraItems);
  const showFooter = hasMenuContent(footerItems);
  const showHide = has('hide');
  const showBase = BASE_ACTIONS.some(has);

  return (
    <>
      {has('queue') && (
        <MenuItem icon={<QueueMusicIcon />} disabled={!canQueue} onSelect={addToQueue}>
          {t('キューに追加')}
        </MenuItem>
      )}
      {has('watchLater') && (
        <MenuItem icon={<ClockIcon />} onSelect={toggleWatchLater}>
          {isInWatchLater ? t('後で聴くから削除') : t('後で聴くに保存')}
        </MenuItem>
      )}
      {has('save') && (
        <MenuItem icon={<PlaylistAddIcon />} onSelect={saveToPlaylist}>
          {t('プレイリストに保存')}
        </MenuItem>
      )}
      {has('share') && (
        <MenuItem icon={<ShareIcon />} onSelect={share}>
          {t('共有')}
        </MenuItem>
      )}
      {has('openVocaDb') && (
        <MenuItem
          icon={<OpenInNewIcon />}
          href={`https://vocadb.net/S/${song.id}`}
          external
          onSelect={() => onAction?.('openVocaDb')}
        >
          {t('VocaDBで開く')}
        </MenuItem>
      )}
      {showBase && (showExtra || showHide) && <MenuDivider />}
      {showExtra && extraItems}
      {showHide && (
        <MenuItem icon={isHidden ? <EyeIcon /> : <EyeOffIcon />} onSelect={toggleHidden}>
          {isHidden ? t('再表示') : t('表示しない')}
        </MenuItem>
      )}
      {showFooter && (showBase || showExtra || showHide) && <MenuDivider />}
      {showFooter && footerItems}
    </>
  );
}
