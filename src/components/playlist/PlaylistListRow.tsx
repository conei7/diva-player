import type { Playlist } from '../../types/vocadb';
import { cx } from '../ui/overlay';
import PlaylistActionsMenu, { type PlaylistActionHandlers } from './PlaylistActionsMenu';
import { PlaylistKindLine, PlaylistTitleLink } from './PlaylistCard';
import PlaylistThumbnail from './PlaylistThumbnail';
import { usePlaylistText } from './usePlaylistText';

interface PlaylistListRowProps {
  playlist: Playlist;
  folderName?: string;
  actions: PlaylistActionHandlers;
  onOpen?: () => void;
  /** 'sm': 128×72 (desktop list view). 'lg': 160×90 with the stacked lines (phones). */
  size?: 'sm' | 'lg';
}

/** One playlist as a row: the library's list view and the phone layout. */
export default function PlaylistListRow({ playlist, folderName, actions, onOpen, size = 'sm' }: PlaylistListRowProps) {
  const text = usePlaylistText();
  const large = size === 'lg';

  return (
    <div
      className={cx(
        'group relative isolate flex items-center rounded-card transition-colors duration-150 hover:bg-yt-tonal',
        large ? 'gap-3 px-1 py-1.5' : 'gap-4 p-2',
      )}
      data-testid="playlist-card"
    >
      <PlaylistThumbnail playlist={playlist} className={large ? 'w-40' : 'w-32'} radius="sm" stacked={large} />
      <div className="min-w-0 flex-1">
        <h3 className={cx('m-0 text-sm font-medium leading-5 text-yt-text [overflow-wrap:anywhere]', large ? 'line-clamp-2' : 'line-clamp-1')}>
          <PlaylistTitleLink playlist={playlist} onOpen={onOpen} />
        </h3>
        <div className="mt-1 text-xs leading-[18px] text-yt-text-secondary">
          <PlaylistKindLine playlist={playlist} folderName={folderName} />
          <p className="m-0 truncate">{text.updated(playlist)}</p>
        </div>
      </div>
      <PlaylistActionsMenu playlist={playlist} actions={actions} className="relative z-[2]" />
    </div>
  );
}
