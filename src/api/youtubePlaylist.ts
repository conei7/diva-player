import type { Song } from '../types/vocadb';

const RECOMMENDER_API = import.meta.env.VITE_RECOMMENDER_API || '/backend-api';

export interface YouTubePlaylistSongsResponse {
  playlistId: string;
  title: string;
  videoCount: number;
  matchedCount: number;
  unmatchedVideoIds: string[];
  songs: Song[];
  sourceFetchedAt: string;
  stale: boolean;
  truncated: boolean;
}

export function extractYouTubePlaylistId(input: string): string | null {
  const value = input.trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    const list = url.searchParams.get('list');
    return list && /^[A-Za-z0-9_-]{8,100}$/.test(list) ? list : null;
  } catch {
    return /^[A-Za-z0-9_-]{8,100}$/.test(value) ? value : null;
  }
}

export function normalizeYouTubePlaylistUrl(playlistId: string): string {
  return `https://www.youtube.com/playlist?list=${encodeURIComponent(playlistId)}`;
}

export async function fetchYouTubePlaylistSongs(
  playlistId: string,
  options: { refresh?: boolean; signal?: AbortSignal } = {},
): Promise<YouTubePlaylistSongsResponse> {
  const query = options.refresh ? '?refresh=true' : '';
  const response = await fetch(
    `${RECOMMENDER_API}/api/youtube/playlists/${encodeURIComponent(playlistId)}/songs${query}`,
    { signal: options.signal },
  );
  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || `YouTubeプレイリストの取得に失敗しました (${response.status})`);
  }
  return response.json() as Promise<YouTubePlaylistSongsResponse>;
}
