import { useMemo } from 'react';
import { Link } from 'react-router';
import type { Playlist } from '../../../types/vocadb';
import { useTranslateSourceText } from '../../../i18n';
import { useLanguageStore } from '../../../stores/languageStore';
import { WATCH_LATER_ID } from '../../../stores/playlistStore';
import { displayPlaylistName } from '../../../utils/displayNames';
import { playlistPath } from '../../../utils/routes';
import { formatCount } from '../../../utils/songMeta';
import { getPlaylistCoverCandidates } from '../../playlist/playlistDisplay';
import { usePlaylistText } from '../../playlist/usePlaylistText';
import { ClockIcon, PlayIcon, PlaylistIcon } from '../../ui/icons';
import { cx } from '../../ui/overlay';
import SquareArt from '../SquareArt';
import { SHELF_CARD_WIDTH_CLASS } from './musicHomeShelves';
import { playShelfPlaylist } from './musicHomeSources';

interface ShelfPlaylistCardProps {
  playlist: Playlist;
  /** Mouse devices: the ▶ appears on hover / focus (touch screens always show it). */
  finePointer: boolean;
}

/**
 * Square playlist card of the あなたのプレイリスト shelf: the cover and the name open the playlist,
 * the ▶ plays it from the first song (like the playlist page's すべて再生) without leaving Home.
 */
export default function ShelfPlaylistCard({ playlist, finePointer }: ShelfPlaylistCardProps) {
  const t = useTranslateSourceText();
  const text = usePlaylistText();
  const language = useLanguageStore(state => state.language);
  const candidates = useMemo(() => getPlaylistCoverCandidates(playlist), [playlist]);
  const name = displayPlaylistName(playlist, t);
  const href = playlistPath(playlist.id);
  const canPlay = playlist.songs.length > 0;

  return (
    <li data-testid="music-shelf-playlist" className={cx('group relative shrink-0 snap-start', SHELF_CARD_WIDTH_CLASS)}>
      <div className="relative">
        {/* The title link below is the focusable one; the cover is a second, mouse-only way in. */}
        <Link to={href} tabIndex={-1} aria-hidden="true" draggable={false} className="block rounded-[8px]">
          <SquareArt
            candidates={candidates}
            radius="md"
            className="w-full"
            fallbackIcon={playlist.id === WATCH_LATER_ID
              ? <ClockIcon size={40} />
              : <PlaylistIcon size={40} />}
          />
        </Link>
        {canPlay && (
          <button
            type="button"
            aria-label={t('「{title}」を再生', { title: name })}
            onClick={() => playShelfPlaylist(playlist)}
            className={cx(
              'absolute bottom-2 right-2 flex size-10 cursor-pointer items-center justify-center rounded-full bg-brand text-yt-bg shadow-[0_8px_16px_rgb(0_0_0/0.35)] transition-[opacity,translate] duration-150 [-webkit-tap-highlight-color:transparent] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-yt-focus sm:size-12',
              finePointer
                ? 'translate-y-1 opacity-0 group-hover:translate-y-0 group-hover:opacity-100 group-focus-within:translate-y-0 group-focus-within:opacity-100'
                : 'opacity-100',
            )}
          >
            <PlayIcon size={24} />
          </button>
        )}
      </div>
      <h3 className="m-0 mt-2 text-sm font-medium leading-5 text-yt-text">
        <Link
          to={href}
          className="line-clamp-2 rounded-sm text-inherit no-underline [overflow-wrap:anywhere] hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-yt-focus"
        >
          {name}
        </Link>
      </h3>
      <p className="m-0 mt-0.5 truncate text-sm leading-5 text-yt-text-secondary">
        {text.syncFailed(playlist) ? <span className="text-yt-danger">{t('同期エラー')}</span> : text.kind(playlist)}
        {' · '}
        {formatCount(playlist.songs.length, 'song', language)}
      </p>
    </li>
  );
}
