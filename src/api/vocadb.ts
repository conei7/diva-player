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
    'artistId[]': (() => {
      const ids = [
        ...(params.artistId !== undefined ? [params.artistId] : []),
        ...(params.artistIds ?? []),
      ];
      return ids.length > 0 ? ids : undefined;
    })(),
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
  // sort=SongCount: 同名アーティストが複数いる場合、最も曲が多い（本命の）アーティストを優先
  const url = `${BASE_URL}/artists?${queryParams}&artistTypes=Producer%2CCircle%2CBand&sort=SongCount`;
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

/**
 * ボーカリスト（Vocaloid / UTAU / CeVIO など）を名前で検索してサジェスト用リストを返す。
 */
const VOCALIST_ARTIST_TYPES = 'Vocaloid%2CUTAU%2CCeVIO%2CSynthesizerV%2CNEUTRINO%2CVoiSona%2CVoiceroid%2COtherVoiceSynthesizer%2COtherVocalist';

export async function searchVocalistsByName(query: string): Promise<Artist[]> {
  const trimmed = query.trim();
  if (trimmed.length < 1) return [];

  const queryParams = buildSearchParams({
    query: trimmed,
    maxResults: 8,
    nameMatchMode: 'StartsWith',
    lang: DEFAULT_LANG,
  });

  const url = `${BASE_URL}/artists?${queryParams}&artistTypes=${VOCALIST_ARTIST_TYPES}`;
  const cacheKey = `vocalist:${url}`;

  const cached = getCached<ArtistSearchResult>(cacheKey);
  const data = cached ?? await (async () => {
    const response = await fetchWithRetry(url);
    const result: ArtistSearchResult = await response.json();
    setCache(cacheKey, result);
    return result;
  })();

  return data.items;
}

/**
 * 関連曲を取得（サジェスト・連続再生用）
 * /api/songs/{id}/related: likeMatches / artistMatches / tagMatches を結合して返す
 */
interface RelatedSongsResponse {
  likeMatches: Song[];
  artistMatches: Song[];
  tagMatches: Song[];
}

export async function getRelatedSongs(id: number): Promise<Song[]> {
  const url = `${BASE_URL}/songs/${id}/related?fields=${DEFAULT_FIELDS}&lang=${DEFAULT_LANG}`;
  const cacheKey = `related:${url}`;

  const cached = getCached<RelatedSongsResponse>(cacheKey);
  const data = cached ?? await (async () => {
    const response = await fetchWithRetry(url);
    const result: RelatedSongsResponse = await response.json();
    setCache(cacheKey, result);
    return result;
  })();

  // likeMatches → artistMatches → tagMatches の優先順位で重複排除
  const seen = new Set<number>();
  const result: Song[] = [];
  for (const song of [...data.likeMatches, ...data.artistMatches, ...data.tagMatches]) {
    if (!seen.has(song.id)) {
      seen.add(song.id);
      result.push(song);
    }
  }
  return result;
}

/**
 * ローカル推薦バックエンド API (オプション)
 * backend/ の C# API が localhost:5000 で動作している場合に使用。
 * 利用できない場合は VocaDB の /related にフォールバックする。
 */
const RECOMMENDER_API = 'http://localhost:5000';

interface RecommendItem {
  songId:  number;
  name:    string;
  artist:  string;
  score:   number;
  reason:  string;
}

interface RecommendResponse {
  items: RecommendItem[];
  error: string | null;
}

let _recommenderAvailable: boolean | null = null;

async function isRecommenderAvailable(): Promise<boolean> {
  if (_recommenderAvailable !== null) return _recommenderAvailable;
  try {
    const res = await fetch(`${RECOMMENDER_API}/api/health`, { signal: AbortSignal.timeout(1000) });
    _recommenderAvailable = res.ok;
  } catch {
    _recommenderAvailable = false;
  }
  return _recommenderAvailable;
}

/**
 * 推薦曲を取得 (バックエンドAPIまたはVocaDBにフォールバック)
 */
export async function getRecommendedSongs(
  seedSongId: number,
  count = 10,
  sessionId?: string,
  sessionProgress = 0.0,
  ratings?: Record<string, number>,
  offset = 0,
): Promise<Song[]> {
  // ローカルバックエンドを優先
  if (await isRecommenderAvailable()) {
    try {
      const params = new URLSearchParams({
        songId: String(seedSongId),
        count:  String(count),
        offset: String(offset),
        sessionProgress: String(sessionProgress),
      });
      if (sessionId) params.set('sessionId', sessionId);

      // 評価データをAPIに渡す (id:rating のカンマ区切り、最大30件)
      if (ratings) {
        const pairs = Object.entries(ratings)
          .filter(([, r]) => r >= 1 && r <= 5)
          .slice(0, 30)
          .map(([id, r]) => `${id}:${r}`);
        if (pairs.length > 0) params.set('ratedSongs', pairs.join(','));
      }

      const res = await fetch(`${RECOMMENDER_API}/api/recommend?${params}`);
      if (res.ok) {
        const data: RecommendResponse = await res.json();
        if (!data.error && data.items.length > 0) {
          // バックエンドは曲情報の概要のみ返すので VocaDB から詳細を補完
          const ids = data.items.map(i => i.songId);
          const songs = await Promise.all(ids.map(id => getSongById(id).catch(() => null)));
          return songs.filter((s): s is Song => s !== null);
        }
      }
    } catch {
      _recommenderAvailable = false; // 次回からフォールバック
    }
  }

  // フォールバック: VocaDB /related
  return getRelatedSongs(seedSongId);
}

/**
 * 同一プロデューサーの他の曲を取得
 * producerIds: Song.artists から category=Producer の artist.id を抽出して渡す
 */
export async function getSongsByProducer(
  producerIds: number[],
  excludeId: number,
  maxResults = 20,
  start = 0,
): Promise<{ items: Song[]; totalCount: number }> {
  if (producerIds.length === 0) return { items: [], totalCount: 0 };
  // 最初のプロデューサーIDで検索（複数の場合は最も重要なもの優先）
  const params = buildSearchParams({
    'artistId[]': producerIds[0],
    artistParticipationStatus: 'OnlyMainAlbums',
    sort: 'FavoritedTimes',
    maxResults,
    start,
    getTotalCount: true,
    fields: DEFAULT_FIELDS,
    lang: DEFAULT_LANG,
    onlyWithPVs: true,
  });
  const url = `${BASE_URL}/songs?${params}`;
  const cacheKey = `producer:${url}`;

  const cached = getCached<SongSearchResult>(cacheKey);
  const data = cached ?? await (async () => {
    const response = await fetchWithRetry(url);
    const result: SongSearchResult = await response.json();
    setCache(cacheKey, result);
    return result;
  })();

  const items = data.items.filter(s => s.id !== excludeId);
  return { items, totalCount: data.totalCount };
}

/**
 * タグベースの類似曲を取得（VocaDB タグ ID で絞り込み）
 */
export async function getSongsByTags(
  tagIds: number[],
  excludeId: number,
  maxResults = 20,
  start = 0,
): Promise<{ items: Song[]; totalCount: number }> {
  if (tagIds.length === 0) return { items: [], totalCount: 0 };
  const params = buildSearchParams({
    'tagId[]': tagIds.slice(0, 3), // 上位3タグに絞る
    sort: 'FavoritedTimes',
    maxResults,
    start,
    getTotalCount: true,
    fields: DEFAULT_FIELDS,
    lang: DEFAULT_LANG,
    onlyWithPVs: true,
  });
  const url = `${BASE_URL}/songs?${params}`;
  const cacheKey = `tags:${url}`;

  const cached = getCached<SongSearchResult>(cacheKey);
  const data = cached ?? await (async () => {
    const response = await fetchWithRetry(url);
    const result: SongSearchResult = await response.json();
    setCache(cacheKey, result);
    return result;
  })();

  const items = data.items.filter(s => s.id !== excludeId);
  return { items, totalCount: data.totalCount };
}

/**
 * Qdrant ハイブリッドベクトルによる音響類似曲取得
 * バックエンドが利用不可の場合は VocaDB /related にフォールバック
 */
interface SimilarItem { songId: number; name: string; artist: string; score: number; }
interface SimilarResponse { items: SimilarItem[]; }

export async function getSimilarSongs(
  seedSongId: number,
  count = 20,
  offset = 0,
): Promise<Song[]> {
  if (await isRecommenderAvailable()) {
    try {
      const params = new URLSearchParams({
        songId: String(seedSongId),
        count:  String(count),
        offset: String(offset),
      });
      const res = await fetch(`${RECOMMENDER_API}/api/recommend/similar?${params}`);
      if (res.ok) {
        const data: SimilarResponse = await res.json();
        if (data.items.length > 0) {
          const songs = await Promise.all(data.items.map(i => getSongById(i.songId).catch(() => null)));
          return songs.filter((s): s is Song => s !== null);
        }
      }
    } catch {
      _recommenderAvailable = false;
    }
  }
  // フォールバック: VocaDB /related (offset 0 のみ)
  if (offset === 0) return getRelatedSongs(seedSongId);
  return [];
}

/**
 * 暗黙的フィードバック送信 (再生完了率)
 * completionRate: 0.0 (即スキップ) 〜 1.0 (最後まで再生)
 * fire-and-forget: エラーは無視
 */
export function sendPlayFeedback(songId: number, completionRate: number): void {
  if (!_recommenderAvailable) return; // バックエンドが利用不可なら何もしない
  fetch(`${RECOMMENDER_API}/api/feedback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ songId, completionRate: Math.max(0, Math.min(1, completionRate)) }),
  }).catch(() => {/* fire-and-forget */});
}
