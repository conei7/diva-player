import { SoundMapRequestError, type SoundMapPoint, type SoundMapResponse } from './soundMap';

interface SoundMapPilotFile {
  kind: 'diva-sound-map-pilot';
  mapVersion: string;
  generatedAt: string;
  method: string;
  sourceCount: number;
  sampleCount: number;
  defaultSeedSongId: number;
  items: Array<Omit<SoundMapPoint, 'similarity'>>;
}

function isFinitePoint(point: Omit<SoundMapPoint, 'similarity'>): boolean {
  return Number.isInteger(point.songId)
    && point.songId > 0
    && Number.isFinite(point.x)
    && Number.isFinite(point.y)
    && point.x >= -1
    && point.x <= 1
    && point.y >= -1
    && point.y <= 1;
}

export async function fetchSoundMapPilot(seedSongId: number, signal?: AbortSignal): Promise<SoundMapResponse> {
  const response = await fetch(`${import.meta.env.BASE_URL}.local/sound-map-pilot.json`, {
    cache: 'no-store',
    signal,
  });
  if (!response.ok) {
    throw new SoundMapRequestError(
      '実データpilotファイルがありません。先にexport_sound_map_pilot.pyを実行してください。',
      response.status,
      'sound_map_pilot_missing',
    );
  }
  const payload = await response.json() as SoundMapPilotFile;
  if (payload.kind !== 'diva-sound-map-pilot' || !Array.isArray(payload.items)) {
    throw new SoundMapRequestError('実データpilotファイルの形式が不正です。', 500, 'sound_map_pilot_invalid');
  }
  const validItems = payload.items.filter(isFinitePoint);
  const origin = validItems.find(point => point.songId === seedSongId)
    ?? validItems.find(point => point.songId === payload.defaultSeedSongId)
    ?? validItems[0];
  if (!origin) {
    throw new SoundMapRequestError('実データpilotに表示できる曲がありません。', 500, 'sound_map_pilot_invalid');
  }
  const neighbors = validItems
    .filter(point => point.songId !== origin.songId)
    .sort((left, right) => (
      Math.hypot(left.x - origin.x, left.y - origin.y)
      - Math.hypot(right.x - origin.x, right.y - origin.y)
    ))
    .slice(0, 199);
  return {
    mapVersion: payload.mapVersion,
    generatedAt: payload.generatedAt,
    method: payload.method,
    coordinateCount: validItems.length,
    state: 'ready',
    origin: { ...origin, similarity: null },
    items: [
      { ...origin, similarity: null },
      ...neighbors.map(point => ({ ...point, similarity: null })),
    ],
  };
}
