/**
 * Loading a YouTube or Niconico playlist for PlaylistImportDialog.
 *
 * - YouTube, one-time: the public Invidious proxy lists the videos, then each video is matched
 *   on VocaDB (byPv). Kept from the old YouTubeImportModal.
 * - YouTube, synced: the SBC (YouTube Data API cache) returns matched songs, like the 24h sync.
 * - Niconico (both): the SBC returns the mylist / series with matched songs.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Song } from '../../types/vocadb';
import {
  extractYouTubePlaylistId,
  fetchYouTubePlaylistSongs,
  type YouTubePlaylistSongsResponse,
} from '../../api/youtubePlaylist';
import {
  extractNicoPlaylistSource,
  fetchNicoPlaylistSongs,
  type NicoPlaylistSongsResponse,
} from '../../api/nicoPlaylist';

export type PlaylistImportService = 'youtube' | 'niconico';

export interface PlaylistImportResult {
  service: PlaylistImportService;
  /** Loaded through the sync source (YouTube: the SBC). Niconico results can be saved either way. */
  loadedForSync: boolean;
  /** The source list's own title ('' when unknown). */
  title: string;
  videoCount: number;
  songs: Song[];
  unmatchedVideoIds: string[];
  stale: boolean;
  truncated: boolean;
  youtube?: YouTubePlaylistSongsResponse;
  nico?: NicoPlaylistSongsResponse;
}

export type PlaylistImportPhase =
  | { state: 'idle' }
  | { state: 'loading'; progress?: { done: number; total: number } }
  | { state: 'done'; result: PlaylistImportResult }
  | { state: 'error'; reason: 'invalid-url' | 'invalid-nico-url' | 'failed' };

/** Which service a pasted URL (or ID) belongs to. */
export function detectPlaylistImportService(url: string): PlaylistImportService | null {
  if (extractNicoPlaylistSource(url)) return 'niconico';
  if (extractYouTubePlaylistId(url)) return 'youtube';
  return null;
}

// Development goes through the Vite proxy (/invidious-api); production uses the Pages function.
const INVIDIOUS_PROXY = '/invidious-api';
const VOCADB_BASE = 'https://vocadb.net/api';
const MAX_INVIDIOUS_PAGES = 50;

interface InvidiousPlaylist {
  title?: string;
  videos?: { videoId: string; title: string }[];
}

async function fetchInvidiousPlaylist(listId: string, signal: AbortSignal): Promise<{ title: string; videoIds: string[] }> {
  const seen = new Set<string>();
  const videoIds: string[] = [];
  let title = '';
  for (let page = 1; page <= MAX_INVIDIOUS_PAGES; page++) {
    const response = await fetch(`${INVIDIOUS_PROXY}/api/v1/playlists/${encodeURIComponent(listId)}?page=${page}`, { signal });
    if (!response.ok) {
      if (page === 1) throw new Error(`playlist request failed (${response.status})`);
      break;
    }
    const data: InvidiousPlaylist = await response.json();
    if (page === 1 && typeof data.title === 'string') title = data.title.trim();
    const videos = data.videos ?? [];
    if (videos.length === 0) break;
    for (const video of videos) {
      if (video.videoId && !seen.has(video.videoId)) {
        seen.add(video.videoId);
        videoIds.push(video.videoId);
      }
    }
  }
  return { title, videoIds };
}

async function fetchVocadbByYouTubeId(videoId: string, signal: AbortSignal): Promise<Song | null> {
  const response = await fetch(
    `${VOCADB_BASE}/songs/byPv?pvService=Youtube&pvId=${encodeURIComponent(videoId)}&fields=PVs,Artists`,
    { signal },
  );
  if (!response.ok) return null;
  const data = await response.json();
  if (!data || !data.id) return null;
  // Music videos of other songs, drama PVs and "other" entries are not songs to save.
  if (['DramaPV', 'MusicPV', 'Other'].includes(data.songType)) return null;
  return data as Song;
}

/** Loads one playlist at a time; a new load (or reset) cancels the previous one. */
export function usePlaylistImportLoader() {
  const [phase, setPhase] = useState<PlaylistImportPhase>({ state: 'idle' });
  const controllerRef = useRef<AbortController | null>(null);
  useEffect(() => () => controllerRef.current?.abort(), []);

  const reset = useCallback(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    setPhase({ state: 'idle' });
  }, []);

  const load = useCallback(async (url: string, service: PlaylistImportService, forSync: boolean) => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    const { signal } = controller;
    const finish = (next: PlaylistImportPhase) => {
      if (!signal.aborted) setPhase(next);
    };

    if (service === 'niconico') {
      const source = extractNicoPlaylistSource(url);
      if (!source) {
        setPhase({ state: 'error', reason: 'invalid-nico-url' });
        return;
      }
      setPhase({ state: 'loading' });
      try {
        const response = await fetchNicoPlaylistSongs(source, { refresh: true, signal });
        finish({
          state: 'done',
          result: {
            service,
            loadedForSync: true,
            title: response.title?.trim() ?? '',
            videoCount: response.videoCount,
            songs: response.songs,
            unmatchedVideoIds: response.unmatchedVideoIds,
            stale: response.stale,
            truncated: response.truncated,
            nico: response,
          },
        });
      } catch {
        finish({ state: 'error', reason: 'failed' });
      }
      return;
    }

    const listId = extractYouTubePlaylistId(url);
    if (!listId) {
      setPhase({ state: 'error', reason: 'invalid-url' });
      return;
    }
    setPhase({ state: 'loading' });
    try {
      if (forSync) {
        const response = await fetchYouTubePlaylistSongs(listId, { refresh: true, signal });
        finish({
          state: 'done',
          result: {
            service,
            loadedForSync: true,
            title: response.title?.trim() ?? '',
            videoCount: response.videoCount,
            songs: response.songs,
            unmatchedVideoIds: response.unmatchedVideoIds,
            stale: response.stale,
            truncated: response.truncated,
            youtube: response,
          },
        });
        return;
      }

      const { title, videoIds } = await fetchInvidiousPlaylist(listId, signal);
      finish({ state: 'loading', progress: { done: 0, total: videoIds.length } });
      const matched: Song[] = [];
      const unmatched: string[] = [];
      const batchSize = 5;
      for (let start = 0; start < videoIds.length; start += batchSize) {
        if (signal.aborted) return;
        const batch = videoIds.slice(start, start + batchSize);
        const songs = await Promise.all(batch.map(id => fetchVocadbByYouTubeId(id, signal).catch(error => {
          if (signal.aborted) throw error;
          return null;
        })));
        songs.forEach((song, index) => {
          if (song) matched.push(song);
          else unmatched.push(batch[index]);
        });
        finish({ state: 'loading', progress: { done: Math.min(start + batchSize, videoIds.length), total: videoIds.length } });
      }
      finish({
        state: 'done',
        result: {
          service,
          loadedForSync: false,
          title,
          videoCount: videoIds.length,
          songs: matched,
          unmatchedVideoIds: unmatched,
          stale: false,
          truncated: false,
        },
      });
    } catch {
      finish({ state: 'error', reason: 'failed' });
    }
  }, []);

  return { phase, load, reset };
}
