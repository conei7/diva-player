import type { SmartPlaylistRule, Song, SongSearchResult } from '../types/vocadb';
import { buildSmartPlaylistSearchParams, normalizeSmartPlaylistRule } from '../utils/smartPlaylist';
import { scheduleFetch } from '../utils/requestScheduler';
import { withDefaultSongName } from '../utils/entryNames';

const RECOMMENDER_API = import.meta.env.VITE_RECOMMENDER_API || '/backend-api';

/**
 * スマートプレイリストの保存条件をDB側で先に適用して検索する。
 * VocaDBの先頭ページを取得してから絞り込むと、全体には該当曲があっても0件になるため。
 */
export async function searchSmartPlaylistSongs(
  rule: SmartPlaylistRule,
  maxResults?: number,
  signal?: AbortSignal,
): Promise<{ items: Song[]; totalCount: number }> {
  const limit = maxResults ?? normalizeSmartPlaylistRule(rule).maxSongs;
  const items: Song[] = [];
  const seen = new Set<number>();
  let totalCount: number;
  let start = 0;
  do {
    signal?.throwIfAborted();
    const size = limit === 'all' ? 100 : Math.min(100, limit - items.length);
    const params = buildSmartPlaylistSearchParams(rule, size);
    params.set('start', String(start));
    params.set('compact', 'true');
    const response = await scheduleFetch(`${RECOMMENDER_API}/api/songs/search?${params.toString()}`, { signal }, start === 0 ? 'foreground' : 'background');
    if (!response.ok) throw new Error(`Smart playlist search failed: ${response.status}`);
    const data = await response.json() as SongSearchResult;
    signal?.throwIfAborted();
    totalCount = data.totalCount;
    // The API's bounded offset contract cannot represent an unbounded catalog.
    // Fail before replacing a saved list rather than silently saving a truncated one.
    if (limit === 'all' && totalCount > 100_000) throw new Error('Smart playlist exceeds 100000 songs');
    for (const song of data.items) {
      if (!seen.has(song.id)) { seen.add(song.id); items.push(withDefaultSongName(song)); }
    }
    start += data.items.length;
    if (data.items.length === 0 || start >= totalCount) break;
  } while (limit === 'all' || items.length < limit);
  return { items, totalCount };
}

