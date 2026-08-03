import type { Song } from '../types/vocadb';

const RECOMMENDER_API = import.meta.env.VITE_RECOMMENDER_API || '/backend-api';

export type NicoPlaylistKind = 'mylist' | 'series';

export interface NicoPlaylistSource {
  kind: NicoPlaylistKind;
  id: string;
}

export interface NicoPlaylistSongsResponse {
  sourceKind: NicoPlaylistKind;
  sourceId: string;
  title: string;
  videoCount: number;
  matchedCount: number;
  unmatchedVideoIds: string[];
  songs: Song[];
  sourceFetchedAt: string;
  stale: boolean;
  truncated: boolean;
}

export function extractNicoPlaylistSource(input: string): NicoPlaylistSource | null {
  const value = input.trim();
  if (!value) return null;
  const matchPath = (path: string) => path.match(/\/(mylist|series)\/(\d+)(?:\/|$)/i);
  const shorthand = value.match(/^(mylist|series)[/:](\d+)$/i);
  if (shorthand) return { kind: shorthand[1].toLowerCase() as NicoPlaylistKind, id: shorthand[2] };
  try {
    const url = new URL(value);
    if (!/(^|\.)nicovideo\.jp$/i.test(url.hostname)) return null;
    const match = matchPath(url.pathname);
    return match ? { kind: match[1].toLowerCase() as NicoPlaylistKind, id: match[2] } : null;
  } catch {
    return null;
  }
}

export function normalizeNicoPlaylistUrl(source: NicoPlaylistSource): string {
  return `https://www.nicovideo.jp/${source.kind}/${encodeURIComponent(source.id)}`;
}

export async function fetchNicoPlaylistSongs(
  source: NicoPlaylistSource,
  options: { refresh?: boolean; signal?: AbortSignal } = {},
): Promise<NicoPlaylistSongsResponse> {
  const query = options.refresh ? '?refresh=true' : '';
  const response = await fetch(
    `${RECOMMENDER_API}/api/nico/playlists/${source.kind}/${encodeURIComponent(source.id)}/songs${query}`,
    { signal: options.signal },
  );
  if (!response.ok) {
    if (response.status === 403 || response.status === 404) {
      throw new Error('公開されているニコニコのマイリスト／シリーズを確認できませんでした');
    }
    const message = await response.text();
    throw new Error(message || `ニコニコのプレイリスト取得に失敗しました (${response.status})`);
  }
  return response.json() as Promise<NicoPlaylistSongsResponse>;
}
