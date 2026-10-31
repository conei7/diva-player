/**
 * Network shelves of the music layout's Home and the shelf play actions. Every request uses the
 * arguments of HomeFeed's category for page 0 (HomePage.tsx fetchPrefetchableHomeSongs), so the
 * API caches (`trending:${url}`, the backend search cache) are shared with the feed below.
 */
import { attachExternalViews, getTrendingSongs } from '../../../api/vocadb';
import type { FavoriteProducer } from '../../../stores/favoriteProducerStore';
import type { GlobalFilterSettings } from '../../../stores/globalFilterStore';
import { usePlayerStore } from '../../../stores/playerStore';
import { rerankDisplayedSongs } from '../../../stores/recommendationExposureStore';
import { searchSongsBackend } from '../../../stores/searchStore';
import type { Playlist, Song } from '../../../types/vocadb';
import { requiresExternalViewCounts } from '../../../utils/globalFilters';
import { isDeterministicHomeRankingCategory } from '../../../utils/homeRanking';
import { selectRotatingWindow } from '../../../utils/pageWindow';
import { createRankingSeed } from '../../../utils/rankingRandomization';
import { uniqueSongsById } from '../../../utils/recommendationScoring';
import { filterVoiceSynthSongs } from '../../../utils/voiceSynthSongs';
import { SHELF_SONG_LIMIT } from './musicHomeShelves';

export type NetworkShelfId = 'weekly' | 'surge' | 'new' | 'favoriteProducers';

/** HomeFeed's category each shelf mirrors. */
const HOME_CATEGORY: Record<NetworkShelfId, string> = {
  weekly: 'ranking',
  surge: 'trending',
  new: 'recent',
  favoriteProducers: 'favorite_producers',
};

/** お気に入りPの曲 asks for the songs of this many favourite producers (HomeFeed's first ones). */
const FAVORITE_PRODUCER_SHELF_REQUESTS = 3;

/** One seed per session: the exposure-reranked お気に入りP shelf keeps its order while browsing. */
const SHELF_RANKING_SEED = createRankingSeed();

export interface NetworkShelfContext {
  globalFilterSettings: GlobalFilterSettings;
  favoriteProducers: readonly FavoriteProducer[];
}

function favoriteProducerWindow(context: NetworkShelfContext): FavoriteProducer[] {
  return selectRotatingWindow(context.favoriteProducers, 0, FAVORITE_PRODUCER_SHELF_REQUESTS);
}

/** What the shelf's songs depend on: a new key loads the shelf again. */
export function networkShelfKey(id: NetworkShelfId, context: NetworkShelfContext): string {
  return JSON.stringify([
    id,
    context.globalFilterSettings,
    id === 'favoriteProducers' ? favoriteProducerWindow(context).map(producer => producer.id) : null,
  ]);
}

async function fetchShelfSource(id: NetworkShelfId, context: NetworkShelfContext): Promise<Song[]> {
  const filters = context.globalFilterSettings;
  switch (id) {
    case 'weekly':
      return getTrendingSongs(7, SHELF_SONG_LIMIT, 0, 'weekly', 0, filters, 'background');
    case 'surge':
      return getTrendingSongs(7, SHELF_SONG_LIMIT, 0, 'surge', 0, filters, 'background');
    case 'new':
      return getTrendingSongs(30, SHELF_SONG_LIMIT, 0, 'recent', 0, filters, 'background');
    case 'favoriteProducers': {
      const producers = favoriteProducerWindow(context);
      if (producers.length === 0) return [];
      const results = await Promise.all(producers.map(producer =>
        searchSongsBackend({
          artistIds: [producer.id],
          sort: 'FavoritedTimes',
          sortOrder: 'desc',
          start: 0,
          maxResults: Math.min(12, SHELF_SONG_LIMIT),
          discoveryOnly: true,
          compactCards: true,
          priority: 'background',
        }).then(result => result.items).catch(() => [] as Song[]),
      ));
      return uniqueSongsById(results.flat()).slice(0, SHELF_SONG_LIMIT);
    }
  }
}

/**
 * The shelf's songs before the render-time filters (hidden songs, discovery filter): the same
 * post-processing as HomeFeed's fetchSongs (exposure rerank for non-ranking feeds, external view
 * counts when a view filter needs them, voice-synth songs only).
 */
export async function loadNetworkShelfSongs(id: NetworkShelfId, context: NetworkShelfContext): Promise<Song[]> {
  let songs = await fetchShelfSource(id, context);
  if (!isDeterministicHomeRankingCategory(HOME_CATEGORY[id])) {
    songs = rerankDisplayedSongs(songs, SHELF_RANKING_SEED);
  }
  if (requiresExternalViewCounts(context.globalFilterSettings)) {
    songs = await attachExternalViews(songs);
  }
  return filterVoiceSynthSongs(songs);
}

/**
 * Plays a shelf song where it is (Home stays open). The song that is already loaded only pauses or
 * resumes: setQueue would restart its video.
 */
export function playShelfSong(song: Song): void {
  const player = usePlayerStore.getState();
  if (player.currentSong?.id === song.id) {
    if (player.isPlaying) player.pause();
    else player.resume();
    return;
  }
  // Like the song page: the song the user picked seeds the autoplay mix.
  player.setRootSeed(song);
  player.setQueue([song], 0, true, 'manual');
}

/** ▶ on a playlist card: the same as the playlist page's すべて再生. */
export function playShelfPlaylist(playlist: Playlist): void {
  if (playlist.songs.length === 0) return;
  usePlayerStore.getState().setQueue(playlist.songs, 0, true, 'manual', playlist.name);
}
