import { Link } from 'react-router';
import type { Playlist } from '../../types/vocadb';
import { useTranslateSourceText } from '../../i18n';
import { displayPlaylistName } from '../../utils/displayNames';
import { playlistPath } from '../../utils/routes';
import { PlayIcon } from '../ui/icons';
import { cx } from '../ui/overlay';
import PlaylistActionsMenu, { type PlaylistActionHandlers } from './PlaylistActionsMenu';
import PlaylistThumbnail from './PlaylistThumbnail';
import { usePlaylistText } from './usePlaylistText';

/** 「プレイリスト · よく聴く」 (red 「同期エラー」 when the last sync failed). */
export function PlaylistKindLine({ playlist, folderName, className }: { playlist: Playlist; folderName?: string; className?: string }) {
  const t = useTranslateSourceText();
  const text = usePlaylistText();
  const failed = text.syncFailed(playlist);
  return (
    <p className={cx('m-0 truncate', className)}>
      {failed ? <span className="text-yt-danger">{t('同期エラー')}</span> : text.kind(playlist)}
      {folderName ? ` · ${folderName}` : ''}
    </p>
  );
}

/** The link that covers the whole card or row (its ::after stretches over the parent). */
export function PlaylistTitleLink({ playlist, onOpen, className }: { playlist: Playlist; onOpen?: () => void; className?: string }) {
  const t = useTranslateSourceText();
  return (
    <Link
      to={playlistPath(playlist.id)}
      onClick={onOpen}
      className={cx(
        "text-inherit no-underline outline-none after:absolute after:inset-0 after:z-[1] after:rounded-card after:content-['']",
        'focus-visible:after:outline-2 focus-visible:after:outline-offset-2 focus-visible:after:outline-yt-focus',
        className,
      )}
    >
      {displayPlaylistName(playlist, t)}
    </Link>
  );
}

interface PlaylistCardProps {
  playlist: Playlist;
  folderName?: string;
  actions: PlaylistActionHandlers;
  /** Called before the card's link navigates (the library remembers its scroll position). */
  onOpen?: () => void;
  /** Mouse devices: hovering the thumbnail offers 「すべて再生」. */
  hoverPlay?: boolean;
}

/** Library grid card: stacked 16:9 cover, two-line title, kind · folder, last update, ⋮. */
export default function PlaylistCard({ playlist, folderName, actions, onOpen, hoverPlay = false }: PlaylistCardProps) {
  const t = useTranslateSourceText();
  const text = usePlaylistText();
  const canPlay = hoverPlay && playlist.songs.length > 0;

  return (
    <div className="group relative isolate min-w-0" data-testid="playlist-card">
      <PlaylistThumbnail playlist={playlist}>
        {canPlay && (
          <button
            type="button"
            onClick={() => actions.onPlayAll(playlist)}
            className="absolute inset-0 z-[2] flex cursor-pointer items-center justify-center gap-1.5 bg-black/60 text-sm font-medium leading-5 text-white opacity-0 transition-opacity duration-150 hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none"
          >
            <PlayIcon size={24} />
            {t('すべて再生')}
          </button>
        )}
      </PlaylistThumbnail>
      <div className="mt-3 flex items-start gap-1">
        <div className="min-w-0 flex-1">
          <h3 className="m-0 line-clamp-2 text-base font-medium leading-[22px] text-yt-text [overflow-wrap:anywhere]">
            <PlaylistTitleLink playlist={playlist} onOpen={onOpen} />
          </h3>
          <div className="mt-1 text-sm leading-5 text-yt-text-secondary">
            <PlaylistKindLine playlist={playlist} folderName={folderName} />
            <p className="m-0 truncate">{text.updated(playlist)}</p>
          </div>
        </div>
        <PlaylistActionsMenu playlist={playlist} actions={actions} className="relative z-[2] -mr-2 -mt-2" />
      </div>
    </div>
  );
}
