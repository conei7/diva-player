import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { useTranslateSourceText } from '../../../i18n';
import { usePlaylistStore } from '../../../stores/playlistStore';
import { displayPlaylistName } from '../../../utils/displayNames';
import { NAV_ITEMS } from '../../layout/navItems';
import { useNavLabels } from '../../layout/navHooks';
import { getPlaylistCoverCandidates } from '../../playlist/playlistDisplay';
import { PlayIcon, PlaylistIcon } from '../../ui/icons';
import { cx } from '../../ui/overlay';
import { DESTINATION_TILE_CLASS } from '../library/libraryModel';
import SquareArt from '../SquareArt';
import { orderShelfPlaylists, readPlaylistListPreferences } from './musicHomeShelves';
import { playShelfPlaylist } from './musicHomeSources';
import { buildQuickTiles, type QuickTile } from './musicHomeTiles';

function TileArt({ tile }: { tile: QuickTile }) {
  const playlist = tile.destination ? undefined : tile.playlist;
  const candidates = useMemo(() => (playlist ? getPlaylistCoverCandidates(playlist) : []), [playlist]);
  if (tile.destination) {
    const Icon = NAV_ITEMS[tile.destination].activeIcon;
    return (
      <span aria-hidden="true" className={cx('flex size-12 shrink-0 items-center justify-center sm:size-14', DESTINATION_TILE_CLASS[tile.destination])}>
        <Icon size={24} />
      </span>
    );
  }
  return (
    <SquareArt
      candidates={candidates}
      radius="sm"
      className="size-12 rounded-r-none sm:size-14"
      fallbackIcon={<PlaylistIcon size={24} />}
    />
  );
}

/**
 * Home's quick tiles (music layout): wide tiles in a grid at the top of the page, each opening its list
 * or page; a tile for a playlist with songs also has a round ▶ that plays it (on hover / focus with a
 * mouse, always on touch screens). The grid follows the page's width, not the window's (the library and
 * the 再生中 panel take part of it).
 */
export default function QuickTiles({ finePointer }: { finePointer: boolean }) {
  const t = useTranslateSourceText();
  const { full } = useNavLabels();
  const playlists = usePlaylistStore(state => state.playlists);
  const [preferences] = useState(readPlaylistListPreferences);
  const tiles = useMemo(
    () => buildQuickTiles(playlists, orderShelfPlaylists(playlists, preferences), full, playlist => displayPlaylistName(playlist, t)),
    [full, playlists, preferences, t],
  );

  return (
    <ul
      aria-label={t('クイックアクセス')}
      data-testid="music-quick-tiles"
      className="m-0 grid list-none grid-cols-2 gap-2 p-0 @min-[48rem]:grid-cols-4"
    >
      {tiles.map(tile => (
        <QuickTileItem key={tile.key} tile={tile} finePointer={finePointer} />
      ))}
    </ul>
  );
}

function QuickTileItem({ tile, finePointer }: { tile: QuickTile; finePointer: boolean }) {
  const t = useTranslateSourceText();
  const playlist = tile.playable ? tile.playlist : undefined;
  let play: ReactNode = null;
  if (playlist) {
    play = (
      <button
        type="button"
        aria-label={t('「{title}」を再生', { title: tile.label })}
        onClick={() => playShelfPlaylist(playlist)}
        className={cx(
          'absolute right-2 top-1/2 flex size-8 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full bg-brand text-yt-bg shadow-[0_8px_8px_rgb(0_0_0/0.3)] transition-[opacity,scale] duration-150 hover:scale-105 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-yt-focus',
          finePointer ? 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100' : 'opacity-100',
        )}
      >
        <PlayIcon size={20} />
      </button>
    );
  }
  return (
    <li data-testid="music-quick-tile" className="group relative min-w-0">
      <Link
        to={tile.to}
        className={cx(
          'flex min-w-0 items-center gap-3 overflow-hidden rounded-[4px] bg-(--music-tile) text-yt-text no-underline transition-colors duration-150 hover:bg-(--music-tile-hover) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-yt-focus',
          playlist ? 'pr-12' : 'pr-3',
        )}
      >
        <TileArt tile={tile} />
        <span className="line-clamp-2 min-w-0 flex-1 break-words text-sm font-bold leading-[18px]">{tile.label}</span>
      </Link>
      {play}
    </li>
  );
}
