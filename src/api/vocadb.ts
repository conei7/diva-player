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
const RECOMMENDER_API = import.meta.env.VITE_RECOMMENDER_API || '/backend-api';
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
 * 外部の再生回数（YouTube, NicoNico）をバックエンドから取得してマージする
 */
export async function attachExternalViews(songs: Song[]): Promise<Song[]> {
  if (!songs || songs.length === 0) return songs;
  try {
    const ids = songs.map(s => s.id).join(',');
    const res = await fetch(`${RECOMMENDER_API}/api/songs/views?ids=${ids}`);
    if (res.ok) {
      const viewsMap: Record<number, { youtubeViews: number; nicoViews: number }> = await res.json();
      return songs.map(song => {
        const views = viewsMap[song.id];
        if (views) {
          return { ...song, youtubeViews: views.youtubeViews, nicoViews: views.nicoViews };
        }
        return song;
      });
    }
  } catch (e) {
    console.error('Failed to fetch external views', e);
  }
  return songs;
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
  
  data.items = await attachExternalViews(data.items);
  
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
  let data: Song = await response.json();
  
  const enriched = await attachExternalViews([data]);
  data = enriched[0];
  
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
  let data: Song[] = await response.json();
  
  data = await attachExternalViews(data);
  
  setCache(cacheKey, data);
  return data;
}

export async function getTrendingSongs(
  days = 30,
  maxResults = 24,
  start = 0,
  mode: 'growth' | 'surge' | 'recent' = 'growth',
  seed = 0,
): Promise<Song[]> {
  const params = new URLSearchParams({
    days: String(days),
    start: String(start),
    maxResults: String(maxResults),
    mode,
    seed: String(Math.max(0, Math.floor(seed)) % 64),
  });
  const url = `${RECOMMENDER_API}/api/songs/trending?${params}`;
  const cacheKey = `trending:${url}`;

  const cached = getCached<Song[]>(cacheKey);
  if (cached) return cached;

  if (await isRecommenderAvailable()) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        const data: SongSearchResult = await res.json();
        setCache(cacheKey, data.items);
        return data.items;
      }
    } catch {
      _recommenderAvailable = false;
      _recommenderCheckedAt = Date.now();
    }
  }

  return getTopSongs(168, maxResults);
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

export type SearchSuggestion =
  | { kind: 'song'; id: number; label: string; sublabel: string; song: Song }
  | { kind: 'producer'; id: number; label: string; sublabel: string; artist: Artist }
  | { kind: 'vocalist'; id: number; label: string; sublabel: string; artist: Artist };

const PRODUCER_ARTIST_TYPES = 'Producer%2CCircle%2CBand';

async function searchArtistsByName(
  query: string,
  artistTypes: string,
  maxResults: number,
  cachePrefix: string,
): Promise<Artist[]> {
  const trimmed = query.trim();
  if (trimmed.length < 1) return [];

  const queryParams = buildSearchParams({
    query: trimmed,
    maxResults,
    nameMatchMode: 'StartsWith',
    lang: DEFAULT_LANG,
  });

  const url = `${BASE_URL}/artists?${queryParams}&artistTypes=${artistTypes}&sort=SongCount`;
  const cacheKey = `${cachePrefix}:${url}`;

  const cached = getCached<ArtistSearchResult>(cacheKey);
  const data = cached ?? await (async () => {
    const response = await fetchWithRetry(url);
    const result: ArtistSearchResult = await response.json();
    setCache(cacheKey, result);
    return result;
  })();

  return data.items;
}

export async function searchProducersByName(query: string, maxResults = 8): Promise<Artist[]> {
  return searchArtistsByName(query, PRODUCER_ARTIST_TYPES, maxResults, 'producer');
}

/**
 * 検索バー用サジェスト候補を取得する。
 * 曲名、P/サークル/バンド、シンガーを並行取得し、UI側でそのまま選べる形にする。
 */
export async function getSearchSuggestions(query: string): Promise<SearchSuggestion[]> {
  const trimmed = query.trim();
  if (trimmed.length < 2) return [];

  const [songResult, producers, vocalists] = await Promise.all([
    searchSongs({
      query: trimmed,
      sort: 'FavoritedTimes',
      maxResults: 5,
      start: 0,
      getTotalCount: false,
      onlyWithPVs: true,
      nameMatchMode: 'Auto',
    }),
    searchArtistsByName(trimmed, PRODUCER_ARTIST_TYPES, 4, 'suggest-producer'),
    searchArtistsByName(trimmed, VOCALIST_ARTIST_TYPES, 4, 'suggest-vocalist'),
  ]);

  const suggestions: SearchSuggestion[] = [];
  const seen = new Set<string>();

  for (const song of songResult.items) {
    const key = `song:${song.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    suggestions.push({
      kind: 'song',
      id: song.id,
      label: song.name,
      sublabel: song.artistString || '曲',
      song,
    });
  }

  for (const artist of producers) {
    const key = `producer:${artist.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    suggestions.push({
      kind: 'producer',
      id: artist.id,
      label: artist.name,
      sublabel: `${artist.artistType} の曲を検索`,
      artist,
    });
  }

  for (const artist of vocalists) {
    const key = `vocalist:${artist.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    suggestions.push({
      kind: 'vocalist',
      id: artist.id,
      label: artist.name,
      sublabel: `${artist.artistType} で絞り込み`,
      artist,
    });
  }

  return suggestions.slice(0, 10);
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
  let result: Song[] = [];
  for (const song of [...data.likeMatches, ...data.artistMatches, ...data.tagMatches]) {
    if (!seen.has(song.id)) {
      seen.add(song.id);
      result.push(song);
    }
  }
  
  result = await attachExternalViews(result);
  return result;
}

/**
 * ローカル推薦バックエンド API (オプション)
 * backend/ の C# API が localhost:5000 で動作している場合に使用。
 * 利用できない場合は VocaDB の /related にフォールバックする。
 */

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
let _recommenderCheckPromise: Promise<boolean> | null = null;
let _recommenderCheckedAt = 0;
const RECOMMENDER_CHECK_TTL = 30_000;

async function isRecommenderAvailable(): Promise<boolean> {
  if (
    _recommenderAvailable !== null
    && Date.now() - _recommenderCheckedAt < RECOMMENDER_CHECK_TTL
  ) {
    return _recommenderAvailable;
  }

  // 並行呼び出しでも1回だけヘルスチェックを実行
  if (!_recommenderCheckPromise) {
    _recommenderCheckPromise = (async () => {
      let available: boolean;
      try {
        const res = await fetch(`${RECOMMENDER_API}/api/health`, { signal: AbortSignal.timeout(1500) });
        available = res.ok;
      } catch {
        available = false;
      }
      _recommenderAvailable = available;
      _recommenderCheckedAt = Date.now();
      return available;
    })().finally(() => {
      _recommenderCheckPromise = null;
    });
  }
  return _recommenderCheckPromise;
}

export interface MultiRecommendationSeed {
  songId: number;
  weight: number;
}

/**
 * 推薦曲を取得 (バックエンドAPIまたはVocaDBにフォールバック)
 */
export async function getRecommendedSongs(
  seedSongId: number,
  count = 10,
  sessionProgress = 0.0,
  ratings?: Record<string, number>,
  offset = 0,
): Promise<Song[]> {
  void ratings;
  // ローカルバックエンドを優先
  if (await isRecommenderAvailable()) {
    try {
      const params = new URLSearchParams({
        songId: String(seedSongId),
        count:  String(count),
        offset: String(offset),
        sessionProgress: String(sessionProgress),
      });
      // 評価データをAPIに渡す (id:rating のカンマ区切り、最大30件)
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
      _recommenderCheckedAt = Date.now();
    }
  }

  // フォールバック: VocaDB /related
  return getRelatedSongs(seedSongId);
}

/**
 * Sends only temporary seed IDs and exclusions to the SBC. Older SBC versions
 * transparently fall back to the existing per-seed endpoint.
 */
export async function getMultiRecommendedSongs(
  seeds: MultiRecommendationSeed[],
  count = 30,
  excludeSongIds: number[] = [],
): Promise<Song[]> {
  const normalizedSeeds = seeds
    .filter(seed => Number.isInteger(seed.songId) && seed.songId > 0 && Number.isFinite(seed.weight) && seed.weight > 0)
    .slice(0, 8);
  if (normalizedSeeds.length === 0) return [];

  if (await isRecommenderAvailable()) {
    try {
      const res = await fetch(`${RECOMMENDER_API}/api/recommend/multi`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          seeds: normalizedSeeds,
          count,
          excludeSongIds: excludeSongIds.slice(0, 500),
        }),
      });
      if (res.ok) {
        const data: RecommendResponse = await res.json();
        if (!data.error && data.items.length > 0) {
          const songs = await Promise.all(data.items.map(item => getSongById(item.songId).catch(() => null)));
          return songs.filter((song): song is Song => song !== null);
        }
      }
    } catch {
      // The existing per-seed path below remains available even if an older
      // SBC does not provide the multi-seed endpoint yet.
    }
  }

  const results = await Promise.all(normalizedSeeds.map(async seed => ({
    weight: seed.weight,
    songs: await getRecommendedSongs(seed.songId, count),
  })));
  const scoreBySongId = new Map<number, { song: Song; score: number }>();
  const excluded = new Set(excludeSongIds);
  normalizedSeeds.forEach(seed => excluded.add(seed.songId));
  for (const { weight, songs } of results) {
    songs.forEach((song, index) => {
      if (excluded.has(song.id)) return;
      const current = scoreBySongId.get(song.id) ?? { song, score: 0 };
      current.score += weight / (60 + index + 1);
      scoreBySongId.set(song.id, current);
    });
  }
  return [...scoreBySongId.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, count)
    .map(entry => entry.song);
}

/**
 * ローカルバックエンド経由で同一プロデューサーの曲を取得
 * バックエンド不可時は VocaDB artistId 検索にフォールバック
 */
interface ProducerSongItem { songId: number; name: string; artistString: string; }
interface ProducerSongResponse { items: ProducerSongItem[]; }

export async function getSongsByProducerFromBackend(
  seedSongId: number,
  producerIds: number[],
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
      const res = await fetch(`${RECOMMENDER_API}/api/recommend/producer?${params}`);
      if (res.ok) {
        const data: ProducerSongResponse = await res.json();
        if (data.items.length > 0) {
          const songs = await Promise.all(data.items.map(i => getSongById(i.songId).catch(() => null)));
          return songs.filter((s): s is Song => s !== null);
        }
      }
    } catch {
      _recommenderAvailable = false;
      _recommenderCheckedAt = Date.now();
    }
  }
  // フォールバック: VocaDB artistId 検索
  if (producerIds.length === 0) return [];
  const { items } = await getSongsByProducer(producerIds, seedSongId, count, offset);
  return items;
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
    result.items = await attachExternalViews(result.items);
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
    result.items = await attachExternalViews(result.items);
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
      _recommenderCheckedAt = Date.now();
    }
  }
  // フォールバック: VocaDB /related は全件一括（offset/pagination なし）
  // offset=0 のページだけ全件返す
  if (offset === 0) return getRelatedSongs(seedSongId);
  return [];
}

/**
 * メタデータベクトルのみによる類似検索 (関連曲タブ)
 * バックエンドが利用不可の場合は VocaDB /related にフォールバック
 */
export async function getMetadataSimilarSongs(
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
      const res = await fetch(`${RECOMMENDER_API}/api/recommend/metadata?${params}`);
      if (res.ok) {
        const data: SimilarResponse = await res.json();
        if (data.items.length > 0) {
          const songs = await Promise.all(data.items.map(i => getSongById(i.songId).catch(() => null)));
          return songs.filter((s): s is Song => s !== null);
        }
      }
    } catch {
      _recommenderAvailable = false;
      _recommenderCheckedAt = Date.now();
    }
  }
  if (offset === 0) return getRelatedSongs(seedSongId);
  return [];
}

/**
 * 音響ベクトルのみによる類似検索 (deep dig タブ)
 * バックエンドで音響特徴が見つからない場合は空配列を返し、フロントエンドで未対応表示を行う
 */
export async function getAudioSimilarSongs(
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
      const res = await fetch(`${RECOMMENDER_API}/api/recommend/audio?${params}`);
      if (res.ok) {
        const data: SimilarResponse = await res.json();
        if (data.items.length > 0) {
          const songs = await Promise.all(data.items.map(i => getSongById(i.songId).catch(() => null)));
          return songs.filter((s): s is Song => s !== null);
        }
      }
    } catch {
      _recommenderAvailable = false;
      _recommenderCheckedAt = Date.now();
    }
  }
  return [];
}

/**
 * 暗黙的フィードバック送信 (再生完了率 / キュー削除)
 * completionRate: 0.0 (即スキップ) 〜 1.0 (最後まで再生)
 * action: 'queue_remove' でキュー削除ペナルティを送信
 * fire-and-forget: エラーは無視
 */
