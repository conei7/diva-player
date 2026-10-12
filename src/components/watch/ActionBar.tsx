import StarRating from '../player/StarRating';
import PVSourceSelector from '../player/PVSourceSelector';
import { useRatingStore } from '../../stores/ratingStore';
import { useUiStore } from '../../stores/uiStore';
import { usePlaylistStore, WATCH_LATER_ID } from '../../stores/playlistStore';
import { useHiddenSongStore } from '../../stores/hiddenSongStore';
import { showToast } from '../../stores/toastStore';
import type { Song } from '../../types/vocadb';
import { useTranslateSourceText } from '../../i18n';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import Button, { buttonClassName } from '../ui/Button';
import Tooltip from '../ui/Tooltip';
import { CheckIcon, ClockIcon, EyeIcon, EyeOffIcon, OpenInNewIcon, PlaylistAddIcon, ShareIcon } from '../ui/icons';
import { cx } from '../ui/overlay';
import { hideSongWithUndo, shareSong, toggleWatchLater } from './watchActions';

/** 1024–1279px: the side column leaves little room, so 「保存」 and 「VocaDB」 show only their icons. */
const NARROW_DESKTOP_QUERY = '(min-width: 1024px) and (max-width: 1279.98px)';

/**
 * 操作 (right of the producer row), all as pills without a ⋮:
 * rating · 共有 · 保存 · 後で聴く · video source · VocaDB · 表示しない.
 * They wrap on wide screens and scroll sideways under 640px.
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
    <div
      data-testid="watch-action-bar"
      className="flex min-w-0 items-center gap-2 max-sm:-mx-3 max-sm:overflow-x-auto max-sm:px-3 max-sm:[scrollbar-width:none] sm:flex-wrap max-sm:[&::-webkit-scrollbar]:hidden"
    >
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

      <Button
        icon={inWatchLater ? <CheckIcon /> : <ClockIcon />}
        aria-pressed={inWatchLater}
        onClick={() => toggleWatchLater(song, t)}
      >
        {t('後で聴く')}
      </Button>

      <PVSourceSelector song={song} />

      <Tooltip content={t('VocaDBで開く')}>
        <a
          href={`https://vocadb.net/S/${song.id}`}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={t('VocaDBで開く')}
          className={cx(buttonClassName(), narrow ? 'w-9 px-0!' : 'pl-3')}
        >
          <span aria-hidden="true" className="flex shrink-0 items-center [&>svg]:size-5"><OpenInNewIcon /></span>
          {!narrow && <span className="min-w-0 truncate">VocaDB</span>}
        </a>
      </Tooltip>

      <Button
        icon={hiddenRecord ? <EyeIcon /> : <EyeOffIcon />}
        onClick={toggleHidden}
      >
        {hiddenRecord ? t('再表示') : t('表示しない')}
      </Button>
    </div>
  );
}
