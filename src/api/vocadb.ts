/**
 * VocaDB API Client
 * 
 * VocaDB公式RESTful APIへのリクエストを管理する。
 * - CORS対応済み（フロントエンドから直接呼び出し可能）
 * - レスポンスキャッシュ（5分間）
 * - リトライロジック（指数バックオフ）
 */

import type { Artist, ArtistSearchResult, Song, SongSearchParams, SongSearchResult } from '../types/vocadb';

const BASE_URL = 'https://vocadb.net/api';
const DEFAULT_LANG = 'Japanese';
const DEFAULT_FIELDS = 'PVs,Artists,ThumbUrl';
const CACHE_TTL = 5 * 60 * 1000; // 5分
const MAX_RETRIES = 3;

// シンプルなメモリキャッシュ
const cache = new Map<string, { data: unknown; timestamp: number }>();

function getCached<T>(key: string): T | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL) {
    cache.delete(key);
    return null;
  }
  return entry.data as T;
}

function setCache(key: string, data: unknown): void {
  cache.set(key, { data, timestamp: Date.now() });
}

/**
 * 指数バックオフ付きfetch
 */
async function fetchWithRetry(url: string, retries = MAX_RETRIES): Promise<Response> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url);
      
      if (response.ok) return response;
      
      // 4xxエラーはリトライしない
      if (response.status >= 400 && response.status < 500) {
        throw new Error(`API Error ${response.status}: ${response.statusText}`);
      }
      
      // 5xxエラーはリトライ
      if (attempt < retries) {
        const delay = Math.pow(2, attempt) * 500;
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      
      throw new Error(`API Error ${response.status} after ${retries + 1} attempts`);
    } catch (error) {
      if (attempt === retries) throw error;
      const delay = Math.pow(2, attempt) * 500;
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  
  throw new Error('Unreachable');
}

/**
 * URLパラメータを構築
 */
function buildSearchParams(params: Record<string, string | number | boolean | string[] | number[] | undefined>): string {
  const searchParams = new URLSearchParams();
  
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    
    if (Array.isArray(value)) {
      value.forEach(v => searchParams.append(key, String(v)));
    } else {
      searchParams.set(key, String(value));
    }
  }
  
  return searchParams.toString();
}

/**
 * 曲を検索
 */
export async function searchSongs(params: SongSearchParams): Promise<SongSearchResult> {
  const queryParams = buildSearchParams({
    query: params.query || '',
    'tagName[]': params.tagName,
    'tagId[]': params.tagId,
    sort: params.sort || 'FavoritedTimes',
    'songTypes': params.songTypes?.join(','),
    maxResults: params.maxResults || 24,
    start: params.start || 0,
    getTotalCount: params.getTotalCount ?? true,
    fields: params.fields || DEFAULT_FIELDS,
    lang: params.lang || DEFAULT_LANG,
    nameMatchMode: params.nameMatchMode || 'Auto',
    onlyWithPVs: params.onlyWithPVs ?? true,
    artistId: params.artistId,
    artistParticipationStatus: params.artistParticipationStatus,
    minBpm: params.minBpm,
    maxBpm: params.maxBpm,
  });

  const url = `${BASE_URL}/songs?${queryParams}`;
  const cacheKey = url;
  
  const cached = getCached<SongSearchResult>(cacheKey);
  if (cached) return cached;

  const response = await fetchWithRetry(url);
  const data: SongSearchResult = await response.json();
  
  setCache(cacheKey, data);
  return data;
}

/**
 * 曲の詳細を取得
 */
export async function getSongById(id: number): Promise<Song> {
  const url = `${BASE_URL}/songs/${id}?fields=${DEFAULT_FIELDS},Tags&lang=${DEFAULT_LANG}`;
  const cacheKey = url;
  
  const cached = getCached<Song>(cacheKey);
  if (cached) return cached;

  const response = await fetchWithRetry(url);
  const data: Song = await response.json();
  
  setCache(cacheKey, data);
  return data;
}

/**
 * 人気曲ランキングを取得
 */
export async function getTopSongs(
  durationHours: number = 720,
  maxResults: number = 24,
): Promise<Song[]> {
  const queryParams = buildSearchParams({
    durationHours,
    maxResults,
    fields: DEFAULT_FIELDS,
    languagePreference: DEFAULT_LANG,
    filterBy: 'CreateDate',
  });

  const url = `${BASE_URL}/songs/toplisted?${queryParams}`;
  const cacheKey = url;
  
  const cached = getCached<Song[]>(cacheKey);
  if (cached) return cached;

  const response = await fetchWithRetry(url);
  const data: Song[] = await response.json();
  
  setCache(cacheKey, data);
  return data;
}

/**
 * アーティスト名でアーティストを検索し、クエリに近いアーティストを返す。
 * 曲名検索ではなくアーティスト検索にフォールバックするために使用。
 */
export async function findArtistByName(query: string): Promise<Artist | null> {
  const trimmed = query.trim();
  if (trimmed.length < 2) return null;

  // nameMatchMode=Exact + artistTypes=Producer,Circle で完全一致のプロデューサーを優先検索
  // UTAUや絵師など非プロデューサーが先にヒットする問題を防ぐ
  const queryParams = buildSearchParams({
    query: trimmed,
    maxResults: 5,
    nameMatchMode: 'Exact',
    lang: DEFAULT_LANG,
  });

  // artistTypes で Producer / Circle / Band に絞り込む（UTAU・Illustrator などを除外）
  const url = `${BASE_URL}/artists?${queryParams}&artistTypes=Producer%2CCircle%2CBand`;
  const cacheKey = `artist:${url}`;

  const cached = getCached<ArtistSearchResult>(cacheKey);
  const data = cached ?? await (async () => {
    const response = await fetchWithRetry(url);
    const result: ArtistSearchResult = await response.json();
    setCache(cacheKey, result);
    return result;
  })();

  // プライマリ名が完全一致するものを優先、なければ先頭を返す
  const exactPrimary = data.items.find(
    a => a.name.toLowerCase() === trimmed.toLowerCase()
  );
  return exactPrimary ?? (data.items.length > 0 ? data.items[0] : null);
}
