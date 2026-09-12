const RECOMMENDER_API = import.meta.env.VITE_RECOMMENDER_API || '/backend-api';

export interface SoundMapPoint {
  songId: number;
  name: string;
  artistString: string;
  x: number;
  y: number;
  similarity: number | null;
  thumbUrl?: string;
}

export interface SoundMapResponse {
  mapVersion: string;
  generatedAt: string;
  method: string;
  coordinateCount: number;
  state: 'ready' | 'no_audio' | 'no_mapped_neighbors';
  origin: SoundMapPoint;
  items: SoundMapPoint[];
}

export class SoundMapRequestError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(
    message: string,
    status: number,
    code?: string,
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.name = 'SoundMapRequestError';
  }
}

export async function fetchSoundMap(
  seedSongId: number,
  options: { mapVersion?: string; limit?: number; signal?: AbortSignal } = {},
): Promise<SoundMapResponse> {
  const params = new URLSearchParams({
    seedSongId: String(seedSongId),
    limit: String(options.limit ?? 120),
  });
  if (options.mapVersion) params.set('mapVersion', options.mapVersion);
  const response = await fetch(`${RECOMMENDER_API}/api/discovery/sound-map?${params}`, {
    signal: options.signal,
  });
  if (!response.ok) {
    let payload: { error?: string; message?: string } = {};
    try { payload = await response.json() as typeof payload; } catch { /* plain-text response */ }
    throw new SoundMapRequestError(
      payload.message || `Sound map request failed: ${response.status}`,
      response.status,
      payload.error,
    );
  }
  return response.json() as Promise<SoundMapResponse>;
}
