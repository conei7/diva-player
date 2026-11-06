import { useState } from 'react';
import type { MouseEvent } from 'react';
import StarRating from '../player/StarRating';
import PVSourceSelector from '../player/PVSourceSelector';
import { isSilentVolume, unmutePlayer } from '../player/playerMute';
import { ignoresAppVolume, useMusicBarOnSongPage } from '../music/player/playerBarUi';
import { usePlayerStore } from '../../stores/playerStore';
import { useRatingStore } from '../../stores/ratingStore';
import { useUiStore } from '../../stores/uiStore';
import { usePlaylistStore, WATCH_LATER_ID } from '../../stores/playlistStore';
import { useHiddenSongStore } from '../../stores/hiddenSongStore';
import { showToast } from '../../stores/toastStore';
import type { Song } from '../../types/vocadb';
import { useTranslateSourceText } from '../../i18n';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import { useHorizontalOverflow } from '../../hooks/useHorizontalOverflow';
import Button from '../ui/Button';
import IconButton from '../ui/IconButton';
import Menu, { MenuDivider, MenuItem } from '../ui/Menu';
import Tooltip from '../ui/Tooltip';
import { CheckIcon, ClockIcon, EyeIcon, EyeOffIcon, MoreHorizIcon, OpenInNewIcon, PlaylistAddIcon, ShareIcon, VolumeOffIcon } from '../ui/icons';
import { focusElement, getFocusableElements } from '../ui/overlay';
import { hideSongWithUndo, shareSong, toggleWatchLater } from './watchActions';

/** 1024–1279px: the side column leaves little room, so 「保存」 shows only its icon. */
const NARROW_DESKTOP_QUERY = '(min-width: 1024px) and (max-width: 1279.98px)';

/**
 * 操作 (right of the producer row), YouTube's order: rating · 共有 · 保存 · video source (its
 * service mark) · ⋯ (後で聴く, VocaDBで開く, 表示しない). The row fits beside the producers on wide
 * screens and wraps under them otherwise; under 640px it scrolls sideways, edge to edge with the hidden
 * scrollbar of the Home shelves, so a fade marks each side that has more actions past it. While nothing can be heard, ミュートを解除 comes
 * first (the sign of silence on this page without the music layout's player bar under it: the standard
 * layout, music phones and music windows under 420px tall; nothing is drawn on the video).
 */
export default function ActionBar({ song }: { song: Song }) {
  const t = useTranslateSourceText();
  const rating = useRatingStore(state => state.ratings[String(song.id)] ?? 0);
  const setRating = useRatingStore(state => state.setRating);
  const openSaveToPlaylist = useUiStore(state => state.openSaveToPlaylist);
  const inWatchLater = usePlaylistStore(state => state.playlists
    .find(playlist => playlist.id === WATCH_LATER_ID)?.songs.some(item => item.id === song.id) ?? false);
  const hiddenRecord = useHiddenSongStore(state => state.hiddenSongs[String(song.id)]);
  const narrow = useMediaQuery(NARROW_DESKTOP_QUERY);
  const [moreOpen, setMoreOpen] = useState(false);
  const [scrollerRef, overflow] = useHorizontalOverflow<HTMLDivElement>();
  // Where the music layout's player bar is under the page, its mute button shows it; Bilibili takes
  // no volume from the app.
  const silent = usePlayerStore(state => isSilentVolume(state.volume));
  const hasSong = usePlayerStore(state => state.currentSong !== null);
  const service = usePlayerStore(state => state.currentPV?.service);
  const musicBar = useMusicBarOnSongPage();
  const showUnmute = silent && hasSong && !musicBar && !ignoresAppVolume(service);

  // The pill goes away once pressed: the keyboard carries on at the next action instead of <body>.
  const unmute = (event: MouseEvent<HTMLButtonElement>) => {
    const button = event.currentTarget;
    const hadFocus = button === document.activeElement;
    unmutePlayer();
    if (hadFocus) focusElement(getFocusableElements(button.parentElement).find(element => element !== button));
  };

  const toggleHidden = () => {
    if (!hiddenRecord) {
      hideSongWithUndo(song, t);
      return;
    }
    const songKey = String(song.id);
    useHiddenSongStore.getState().restoreSong(song.id);
    showToast(t('再表示しました'), {
      action: {
        label: t('元に戻す'),
        onAction: () => useHiddenSongStore.setState(state => ({
          hiddenSongs: { ...state.hiddenSongs, [songKey]: hiddenRecord },
        })),
      },
    });
  };

  return (
    // Phones: a box for the fades, as wide as the row. sm+: `contents`, so the row itself stays the
    // flex item beside the producers (VideoInfo) and wraps there as before.
    <div className="min-w-0 max-sm:relative max-sm:-mx-3 sm:contents">
      {/* scroll-padding as wide as the fades: an action reached with Tab stops clear of them.
          -my-1 py-1: room inside the scroll box for the focus rings, which it would clip otherwise. */}
      <div
        ref={scrollerRef}
        data-testid="watch-action-bar"
        className="flex min-w-0 items-center gap-2 max-sm:-my-1 max-sm:scroll-pl-3 max-sm:scroll-pr-8 max-sm:overflow-x-auto max-sm:px-3 max-sm:py-1 max-sm:[scrollbar-width:none] sm:flex-wrap max-sm:[&::-webkit-scrollbar]:hidden"
      >
        {showUnmute && (
          <Button icon={<VolumeOffIcon />} onClick={unmute}>
            {t('ミュートを解除')}
          </Button>
        )}

        <div className="flex h-9 shrink-0 items-center rounded-full bg-yt-tonal px-3 max-sm:h-10 max-sm:px-1">
          <StarRating rating={rating} onRate={value => setRating(song.id, value)} size="md" />
        </div>

        <Button icon={<ShareIcon />} aria-label={t('共有')} onClick={() => shareSong(song, t)}>
          {t('共有')}
        </Button>

        <Tooltip content={t('プレイリストに保存')}>
          <Button
            icon={<PlaylistAddIcon />}
            aria-label={t('プレイリストに保存')}
            className={narrow ? 'w-9 px-0!' : undefined}
            onClick={() => openSaveToPlaylist(song)}
          >
            {narrow ? undefined : t('保存')}
          </Button>
        </Tooltip>

        <PVSourceSelector song={song} iconOnly />

        <Menu
          align="end"
          label={t('その他の操作')}
          open={moreOpen}
          onOpenChange={setMoreOpen}
          trigger={(
            <IconButton
              label={t('その他の操作')}
              icon={<MoreHorizIcon />}
              variant="tonal"
              size="sm"
              className="sm:size-9!"
              data-testid="watch-more-actions"
            />
          )}
        >
          <MenuItem icon={inWatchLater ? <CheckIcon /> : <ClockIcon />} onSelect={() => toggleWatchLater(song, t)}>
            {inWatchLater ? t('後で聴くから削除') : t('後で聴くに保存')}
          </MenuItem>
          <MenuItem icon={<OpenInNewIcon />} href={`https://vocadb.net/S/${song.id}`} external>
            {t('VocaDBで開く')}
          </MenuItem>
          <MenuDivider />
          <MenuItem icon={hiddenRecord ? <EyeIcon /> : <EyeOffIcon />} onSelect={toggleHidden} data-testid="watch-hide-song">
            {hiddenRecord ? t('再表示') : t('表示しない')}
          </MenuItem>
        </Menu>
      </div>
      {/* As on the Home shelves: the start fade only covers the 12px gutter, the end one is wider
          because that side hides most of the actions. Each shows only while there is more past it,
          so the first and last action are clear once scrolled to their end. */}
      {overflow.start && (
        <div aria-hidden="true" data-edge-fade="start" className="pointer-events-none absolute inset-y-0 left-0 w-3 bg-linear-to-r from-yt-bg to-transparent sm:hidden" />
      )}
      {overflow.end && (
        <div aria-hidden="true" data-edge-fade="end" className="pointer-events-none absolute inset-y-0 right-0 w-8 bg-linear-to-l from-yt-bg to-transparent sm:hidden" />
      )}
    </div>
  );
}
