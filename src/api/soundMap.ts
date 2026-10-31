const RECOMMENDER_API = import.meta.env.VITE_RECOMMENDER_API || '/backend-api';

export interface SoundMapPoint {
  songId: number;
  name: string;
  artistString: string;
  x: number;
  y: number;
  similarity: number | null;
  thumbUrl?: string;
  featureX?: number | null;
  featureY?: number | null;
}

export interface SoundMapResponse {
  mapVersion: string;
  generatedAt: string;
  method: string;
  coordinateCount: number;
  state: 'ready' | 'no_audio' | 'no_mapped_neighbors';
  origin: SoundMapPoint;
  items: SoundMapPoint[];
  axes?: { x: number; y: number; dimensionCount: number; minX: number; maxX: number; minY: number; maxY: number } | null;
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

export interface GroupSoundMapResponse extends SoundMapResponse {
  axisSelectionVersion?: number;
  axisStandardDeviations?: { x: number; y: number };
  groupSongIds: number[];
  matchingCount: number;
  initialViewport: { centerX: number; centerY: number; zoom: number };
}

/** A first visit prepares a shared server catalogue; aborting a page cancels polling, not that shared job. */
export async function fetchGroupSoundMap(
  songIds: number[],
  options: { viewport?: { centerX: number; centerY: number; zoom: number }; signal: AbortSignal },
): Promise<GroupSoundMapResponse> {
  const params = new URLSearchParams({ songIds: songIds.join(',') });
  if (options.viewport) {
    for (const [key, value] of Object.entries(options.viewport)) params.set(key, String(value));
  }
  for (let attempt = 0; attempt < 65; attempt++) {
    const response = await fetch(`${RECOMMENDER_API}/api/discovery/sound-map/group?${params}`, { signal: options.signal });
    if (response.status === 202) {
      await new Promise<void>((resolve, reject) => {
        options.signal.throwIfAborted();
        const onAbort = () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); };
        const timer = setTimeout(() => { options.signal.removeEventListener('abort', onAbort); resolve(); }, 2000);
        options.signal.addEventListener('abort', onAbort, { once: true });
      });
      continue;
    }
    if (!response.ok) {
      const payload = await response.json().catch(() => ({})) as { error?: string; songIds?: number[] };
      throw new SoundMapRequestError(payload.songIds?.join(', ') || 'Group map request failed', response.status, payload.error);
    }
    return response.json() as Promise<GroupSoundMapResponse>;
  }
  throw new SoundMapRequestError('Catalogue preparation timed out', 503);
}

export async function fetchSoundMap(
  seedSongId: number,
  options: { mapVersion?: string; limit?: number; axisX?: number; axisY?: number; signal?: AbortSignal } = {},
): Promise<SoundMapResponse> {
  const params = new URLSearchParams({
    seedSongId: String(seedSongId),
    limit: String(options.limit ?? 120),
  });
  if (options.mapVersion) params.set('mapVersion', options.mapVersion);
  if (options.axisX !== undefined) params.set('axisX', String(options.axisX));
  if (options.axisY !== undefined) params.set('axisY', String(options.axisY));
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
