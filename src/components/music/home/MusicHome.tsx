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
import {
  greetingPeriod,
  orderShelfPlaylists,
  readPlaylistListPreferences,
  selectRecentShelfSongs,
  SHELF_SONG_LIMIT,
} from './musicHomeShelves';
import {
  loadNetworkShelfSongs,
  networkShelfKey,
  type NetworkShelfContext,
  type NetworkShelfId,
} from './musicHomeSources';
import ShelfPlaylistCard from './ShelfPlaylistCard';
import ShelfSongCard from './ShelfSongCard';
import SongShelf from './SongShelf';
import { useShelfSongs } from './useShelfSongs';

const NO_PLAYS: ReadonlyMap<number, number> = new Map();

/**
 * Home in the music layout: a greeting, horizontal shelves of square cards (recently played, your
 * playlists, rankings, favourite producers) and the 「あなたへのおすすめ」 heading. HomePage renders the
 * existing feed (chips, grid, infinite scroll) right after it as a sibling, so switching the layout
 * never remounts or reloads the feed. Shelves load on their own, appear when ready and disappear
 * quietly when empty or failed.
 */
export default function MusicHome() {
  const t = useTranslateSourceText();
  const finePointer = useMediaQuery(FINE_HOVER_MEDIA_QUERY);
  // Fixed while the page is open, so the heading does not change under the reader.
  const [period] = useState(() => greetingPeriod(new Date().getHours()));
  const greeting = period === 'morning'
    ? t('おはようございます')
    : period === 'afternoon' ? t('こんにちは') : t('こんばんは');

  return (
    <div data-testid="music-home" className="w-full">
      <div className="w-full px-3 pt-4 sm:px-4 lg:px-6">
        <h1 className="m-0 text-2xl font-bold leading-8 text-yt-text">{greeting}</h1>
        <div className="mt-4 flex flex-col gap-6 sm:gap-8">
          <RecentShelf finePointer={finePointer} />
          <PlaylistShelf finePointer={finePointer} />
          <NetworkShelves finePointer={finePointer} />
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
  const cleared = useHistoryStore(state => state.entries.length === 0);
  const hiddenSongs = useHiddenSongStore(state => state.hiddenSongs);
  const entriesRef = useRef<HistoryEntry[] | null>(null);
  if (hydrated && entriesRef.current === null) entriesRef.current = useHistoryStore.getState().entries;
  const entries = entriesRef.current;
  const songs = useMemo(
    () => (entries ? selectRecentShelfSongs(entries, hiddenSongs) : []),
    [entries, hiddenSongs],
  );

  if (!hydrated || cleared || songs.length === 0) return null;
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

function NetworkShelves({ finePointer }: { finePointer: boolean }) {
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
  const common = { sourceContext, discovery, hiddenSongs, ready: discoveryReady, finePointer };

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

interface NetworkShelfProps {
  id: NetworkShelfId;
  title: string;
  showRanks?: boolean;
  sourceContext: NetworkShelfContext;
  discovery: DiscoveryFilterContext;
  hiddenSongs: Record<string, HiddenSongRecord>;
  ready: boolean;
  finePointer: boolean;
}

function NetworkShelf({ id, title, showRanks = false, sourceContext, discovery, hiddenSongs, ready, finePointer }: NetworkShelfProps) {
  const key = networkShelfKey(id, sourceContext);
  const songs = useShelfSongs(id, key, () => loadNetworkShelfSongs(id, sourceContext));
  // The same render-time filters as HomeFeed: hidden songs, then the discovery filter.
  const visible = useMemo(
    () => (songs ? applyDiscoveryFilter(excludeHiddenSongs(songs, hiddenSongs), discovery).slice(0, SHELF_SONG_LIMIT) : []),
    [discovery, hiddenSongs, songs],
  );

  if (!ready || visible.length === 0) return null;
  return (
    <SongShelf shelf={id} title={title} finePointer={finePointer}>
      {visible.map((song, index) => (
        <ShelfSongCard key={song.id} song={song} rank={showRanks ? index + 1 : undefined} finePointer={finePointer} />
      ))}
    </SongShelf>
  );
}
