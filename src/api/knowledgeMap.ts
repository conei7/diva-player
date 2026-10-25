const RECOMMENDER_API = import.meta.env.VITE_RECOMMENDER_API || '/backend-api';

export type KnowledgeMapPlatform = 'youtube' | 'nico';

export interface KnowledgeMapTile {
  songId: number;
  name: string;
  artistString: string;
  views: number;
  thumbUrl?: string;
  known: boolean;
}

export interface PlatformKnowledgeMap {
  platform: KnowledgeMapPlatform;
  totalViews: number;
  knownViews: number;
  coverageRatio: number;
  totalSongCount: number;
  knownSongCount: number;
  knownRemainderViews: number;
  unknownRemainderViews: number;
  tiles: KnowledgeMapTile[];
}

export interface KnowledgeMapResponse {
  generatedAt: string;
  /** Legacy wire name: count of IDs in the playback-history/rating union. */
  historySongCount: number;
  /** Legacy wire name: union IDs matched to discovery-eligible songs. */
  matchedHistorySongCount: number;
  eligibleSongCount: number;
  youtube: PlatformKnowledgeMap;
  nico: PlatformKnowledgeMap;
}

export async function fetchKnowledgeMap(
  knownSongIds: Iterable<number>,
  signal?: AbortSignal,
): Promise<KnowledgeMapResponse> {
  const ids = [...new Set(knownSongIds)]
    .filter(id => Number.isInteger(id) && id > 0)
    .slice(0, 50_000);
  const response = await fetch(`${RECOMMENDER_API}/api/discovery/knowledge-map`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ knownSongIds: ids }),
    signal,
  });
  if (!response.ok) throw new Error(`Knowledge map request failed: ${response.status}`);
  return response.json() as Promise<KnowledgeMapResponse>;
}


export interface KnowledgeMapAtlasData {
  platform: KnowledgeMapPlatform;
  generatedAt: string;
  /** Flat, descending-view pairs: [songId, views, songId, views, ...]. */
  songs: number[];
}

export async function fetchKnowledgeMapAtlas(platform: KnowledgeMapPlatform, signal?: AbortSignal): Promise<KnowledgeMapAtlasData | null> {
  const response = await fetch(`${RECOMMENDER_API}/api/discovery/knowledge-map/atlas?platform=${platform}`, { signal });
  // API-first rolling and Web release can finish at different times.
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Knowledge atlas request failed: ${response.status}`);
  const data = await response.json() as KnowledgeMapAtlasData;
  if (data.platform !== platform || !Array.isArray(data.songs)) throw new Error('Invalid knowledge atlas');
  return data;
}
