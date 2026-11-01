import { useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useTranslate, useTranslateSourceText } from '../../../i18n';
import { FINE_HOVER_MEDIA_QUERY, useMediaQuery } from '../../../hooks/useMediaQuery';
import { useFavoriteProducerStore } from '../../../stores/favoriteProducerStore';
import { useGlobalFilterStore } from '../../../stores/globalFilterStore';
import { excludeHiddenSongs, useHiddenSongStore, type HiddenSongRecord } from '../../../stores/hiddenSongStore';
import { useHistoryStore, type HistoryEntry } from '../../../stores/historyStore';
import { usePlaylistStore } from '../../../stores/playlistStore';
import { useRatingStore } from '../../../stores/ratingStore';
import { applyDiscoveryFilter, type DiscoveryFilterContext } from '../../../utils/globalFilters';
import { playlistsPath } from '../../../utils/routes';
import { NAV_ITEMS } from '../../layout/navItems';
import { useNavLabels } from '../../layout/navHooks';
import {
  orderShelfPlaylists,
  readPlaylistListPreferences,
  selectRecentShelfSongs,
  SHELF_SONG_LIMIT,
} from './musicHomeShelves';
import {
  loadNetworkShelfSongs,
  networkShelfFeedCategory,
  networkShelfKey,
  type NetworkShelfContext,
  type NetworkShelfId,
  type ShelfFeedCategory,
} from './musicHomeSources';
import ShelfPlaylistCard from './ShelfPlaylistCard';
import ShelfSongCard from './ShelfSongCard';
import SongShelf, { SongShelfSkeleton } from './SongShelf';
import { useShelfSongs } from './useShelfSongs';

const NO_PLAYS: ReadonlyMap<number, number> = new Map();

interface MusicHomeProps {
  /** Selects a chip of the feed below and brings its chip bar up (a network shelf's 「すべて表示」). */
  onShowFeedCategory?: (category: ShelfFeedCategory) => void;
}

/**
 * Home in the music layout: horizontal shelves of square cards (recently played, your playlists,
 * rankings, favourite producers) and the 「あなたへのおすすめ」 heading. The page heading (ホーム) is
 * for assistive tech only: the shelves start right under the top bar. HomePage renders the
 * existing feed (chips, grid, infinite scroll) right after it as a sibling, so switching the layout
 * never remounts or reloads the feed. A network shelf that a feed chip continues in the same order
 * (週間ランキング, 急上昇, 新着) has 「すべて表示」 for that chip. Shelves load on their own and never
 * block the page. A shelf that almost always has cards (the network shelves, 最近再生した曲 when
 * plays are stored) keeps its place with a skeleton while it loads, so nothing below jumps when it
 * arrives; shelves that settle empty or fail disappear quietly.
 */
export default function MusicHome({ onShowFeedCategory }: MusicHomeProps) {
  const t = useTranslateSourceText();
  const finePointer = useMediaQuery(FINE_HOVER_MEDIA_QUERY);
  const { full } = useNavLabels();

  return (
    <div data-testid="music-home" className="w-full">
      <div className="group/shelves w-full px-3 pt-4 sm:px-4 lg:px-6">
        <h1 className="sr-only">{full.home}</h1>
        {/* The skeletons are aria-hidden: one label for all of them, there while any is shown. */}
        <span className="sr-only hidden group-has-[[data-testid=music-shelf-loading]]/shelves:block">{t('読み込み中…')}</span>
        <div className="flex flex-col gap-6 sm:gap-8">
          <RecentShelf finePointer={finePointer} />
          <PlaylistShelf finePointer={finePointer} />
          <NetworkShelves finePointer={finePointer} onShowFeedCategory={onShowFeedCategory} />
        </div>
      </div>
      <h2 className="m-0 mt-8 px-3 text-xl font-bold leading-7 text-yt-text sm:px-4 lg:px-6">
        {t('あなたへのおすすめ')}
      </h2>
    </div>
  );
}

/**
 * 最近再生した曲. The order is taken once the history is loaded and kept while Home is open:
 * a song played from a shelf would otherwise jump to the front under the pointer.
 */
function RecentShelf({ finePointer }: { finePointer: boolean }) {
  const t = useTranslateSourceText();
  const hydrated = useHistoryStore(state => state.hasHydrated);
  const hasStoredPlays = useHistoryStore(state => (state.storedPlayCount ?? 0) > 0);
  const cleared = useHistoryStore(state => state.entries.length === 0);
  const hiddenSongs = useHiddenSongStore(state => state.hiddenSongs);
  const entriesRef = useRef<HistoryEntry[] | null>(null);
  if (hydrated && entriesRef.current === null) entriesRef.current = useHistoryStore.getState().entries;
  const entries = entriesRef.current;
  const songs = useMemo(
    () => (entries ? selectRecentShelfSongs(entries, hiddenSongs) : []),
    [entries, hiddenSongs],
  );

  // The song metadata takes a network round trip; the play count is read locally long before.
  if (!hydrated) return hasStoredPlays ? <SongShelfSkeleton /> : null;
  if (cleared || songs.length === 0) return null;
  return (
    <SongShelf shelf="recent" title={t('最近再生した曲')} seeAllTo={NAV_ITEMS.history.to} finePointer={finePointer}>
      {songs.map(song => <ShelfSongCard key={song.id} song={song} finePointer={finePointer} />)}
    </SongShelf>
  );
}

/** あなたのプレイリスト: 後で聴く (when it has songs), then the library's order. */
function PlaylistShelf({ finePointer }: { finePointer: boolean }) {
  const t = useTranslateSourceText();
  const hydrated = usePlaylistStore(state => state.hasHydrated);
  const playlists = usePlaylistStore(state => state.playlists);
  const [preferences] = useState(readPlaylistListPreferences);
  const shown = useMemo(() => orderShelfPlaylists(playlists, preferences), [playlists, preferences]);

  if (!hydrated || shown.length === 0) return null;
  return (
    <SongShelf shelf="playlists" title={t('あなたのプレイリスト')} seeAllTo={playlistsPath()} finePointer={finePointer}>
      {shown.map(playlist => <ShelfPlaylistCard key={playlist.id} playlist={playlist} finePointer={finePointer} />)}
    </SongShelf>
  );
}

function NetworkShelves({ finePointer, onShowFeedCategory }: { finePointer: boolean } & MusicHomeProps) {
  const t = useTranslateSourceText();
  const tk = useTranslate();
  const globalFilterSettings = useGlobalFilterStore(useShallow(state => ({
    enabled: state.enabled,
    minYoutubeViews: state.minYoutubeViews,
    minNicoViews: state.minNicoViews,
    excludedSongTypes: state.excludedSongTypes,
    excludeSelfCovers: state.excludeSelfCovers,
    vocalistFilters: state.vocalistFilters,
    vocalistMatchMode: state.vocalistMatchMode,
    cooldownHours: state.cooldownHours,
    excludeRatedFromDiscovery: state.excludeRatedFromDiscovery,
  })));
  const favoriteProducers = useFavoriteProducerStore(state => state.producers);
  const hiddenSongs = useHiddenSongStore(state => state.hiddenSongs);
  const historyHydrated = useHistoryStore(state => state.hasHydrated);
  // The discovery filter (cooldown, rated songs) uses the plays and ratings from when Home opened:
  // a song played or rated from a shelf stays where it is instead of vanishing under the pointer.
  const [ratings] = useState(() => useRatingStore.getState().ratings);
  const lastPlayedRef = useRef<ReadonlyMap<number, number> | null>(null);
  if (historyHydrated && lastPlayedRef.current === null) {
    lastPlayedRef.current = useHistoryStore.getState().lastPlayedAtBySongId;
  }
  const lastPlayedAtBySongId = lastPlayedRef.current ?? NO_PLAYS;
  // With a cooldown the shelves wait for the history, so no card disappears once shown.
  const discoveryReady = historyHydrated || globalFilterSettings.cooldownHours <= 0;

  const sourceContext = useMemo<NetworkShelfContext>(
    () => ({ globalFilterSettings, favoriteProducers }),
    [favoriteProducers, globalFilterSettings],
  );
  const discovery = useMemo<DiscoveryFilterContext>(
    () => ({ settings: globalFilterSettings, ratings, lastPlayedAtBySongId }),
    [globalFilterSettings, lastPlayedAtBySongId, ratings],
  );
  const common = { sourceContext, discovery, hiddenSongs, ready: discoveryReady, finePointer, onShowFeedCategory };

  return (
    <>
      <NetworkShelf id="weekly" title={t('週間ランキング')} showRanks {...common} />
      <NetworkShelf id="surge" title={tk('categoryTrending')} {...common} />
      <NetworkShelf id="new" title={tk('categoryRecent')} {...common} />
      {favoriteProducers.length > 0 && (
        <NetworkShelf id="favoriteProducers" title={t('お気に入りPの曲')} {...common} />
      )}
    </>
  );
}

interface NetworkShelfProps extends MusicHomeProps {
  id: NetworkShelfId;
  title: string;
  showRanks?: boolean;
  sourceContext: NetworkShelfContext;
  discovery: DiscoveryFilterContext;
  hiddenSongs: Record<string, HiddenSongRecord>;
  ready: boolean;
  finePointer: boolean;
}

function NetworkShelf({
  id, title, showRanks = false, sourceContext, discovery, hiddenSongs, ready, finePointer, onShowFeedCategory,
}: NetworkShelfProps) {
  const key = networkShelfKey(id, sourceContext);
  const feedCategory = networkShelfFeedCategory(id);
  const { songs, failed } = useShelfSongs(id, key, () => loadNetworkShelfSongs(id, sourceContext));
  // The same render-time filters as HomeFeed: hidden songs, then the discovery filter.
  const visible = useMemo(
    () => (songs ? applyDiscoveryFilter(excludeHiddenSongs(songs, hiddenSongs), discovery).slice(0, SHELF_SONG_LIMIT) : []),
    [discovery, hiddenSongs, songs],
  );

  if (failed) return null;
  if (!ready || songs === null) return <SongShelfSkeleton />;
  if (visible.length === 0) return null;
  return (
    <SongShelf
      shelf={id}
      title={title}
      onSeeAll={feedCategory && onShowFeedCategory ? () => onShowFeedCategory(feedCategory) : undefined}
      finePointer={finePointer}
    >
      {visible.map((song, index) => (
        <ShelfSongCard key={song.id} song={song} rank={showRanks ? index + 1 : undefined} finePointer={finePointer} />
      ))}
    </SongShelf>
  );
}
