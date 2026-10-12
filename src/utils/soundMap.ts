import type { SoundMapPoint } from '../api/soundMap';

export type SoundMapViewport = { zoom: number; centerX: number; centerY: number };

export const DEFAULT_SOUND_MAP_VIEWPORT: SoundMapViewport = { zoom: 1, centerX: 0, centerY: 0 };

/** "Previous starting song" keeps at most this many steps (stored in history.state). */
export const SOUND_MAP_TRAIL_LIMIT = 20;

export function clampSoundMapZoom(zoom: number): number {
  return Math.max(0.75, Math.min(5, zoom));
}

export function centerSoundMapOnPoint(point: Pick<SoundMapPoint, 'x' | 'y'>, zoom: number): SoundMapViewport {
  return { zoom: clampSoundMapZoom(zoom), centerX: point.x, centerY: point.y };
}

export function fitSoundMapItems(
  items: readonly Pick<SoundMapPoint, 'x' | 'y'>[],
  paddingRatio = 1.3,
): SoundMapViewport {
  if (items.length === 0) return DEFAULT_SOUND_MAP_VIEWPORT;
  const xs = items.map(item => item.x);
  const ys = items.map(item => item.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const span = Math.max(maxX - minX, maxY - minY, 0.2);
  return {
    zoom: clampSoundMapZoom(2 / (span * paddingRatio)),
    centerX: (minX + maxX) / 2,
    centerY: (minY + maxY) / 2,
  };
}

export function visibleSoundMapItems(
  items: readonly SoundMapPoint[],
  hiddenIds: ReadonlySet<number>,
): SoundMapPoint[] {
  return items.filter(item => !hiddenIds.has(item.songId));
}

export function soundMapItemLabel(item: Pick<SoundMapPoint, 'name' | 'artistString'>): string {
  return item.artistString ? `${item.name} / ${item.artistString}` : item.name;
}

/** 0.973 → 97 (whole percent, clamped to 0–100). */
export function soundMapSimilarityPercent(similarity: number | null | undefined): number | null {
  if (similarity == null || !Number.isFinite(similarity)) return null;
  return Math.round(Math.max(0, Math.min(1, similarity)) * 100);
}

export type SpatialDirection = 'left' | 'right' | 'up' | 'down';

export function arrowKeyDirection(key: string): SpatialDirection | null {
  if (key === 'ArrowLeft') return 'left';
  if (key === 'ArrowRight') return 'right';
  if (key === 'ArrowUp') return 'up';
  if (key === 'ArrowDown') return 'down';
  return null;
}

/**
 * Arrow-key navigation between points on a plane (y grows downward, as on screen).
 * Picks the closest point inside the 90° cone of the pressed direction (points off the
 * axis cost more); when the cone is empty, any point on that side.
 */
export function nearestInDirection<T extends { id: string | number; x: number; y: number }>(
  points: readonly T[],
  fromId: T['id'],
  direction: SpatialDirection,
): T | null {
  const from = points.find(point => point.id === fromId);
  if (!from) return points[0] ?? null;
  let bestInCone: T | null = null;
  let bestInConeScore = Number.POSITIVE_INFINITY;
  let bestOnSide: T | null = null;
  let bestOnSideScore = Number.POSITIVE_INFINITY;
  for (const point of points) {
    if (point.id === fromId) continue;
    const dx = point.x - from.x;
    const dy = point.y - from.y;
    const along = direction === 'right' ? dx : direction === 'left' ? -dx : direction === 'down' ? dy : -dy;
    const across = direction === 'left' || direction === 'right' ? Math.abs(dy) : Math.abs(dx);
    if (along <= 0) continue;
    const score = along + across * 2;
    if (along >= across && score < bestInConeScore) {
      bestInCone = point;
      bestInConeScore = score;
    }
    if (score < bestOnSideScore) {
      bestOnSide = point;
      bestOnSideScore = score;
    }
  }
  return bestInCone ?? bestOnSide;
}

/** The in-app "previous starting song" trail kept in the history entry's state. */
export function readSoundMapTrail(state: unknown): number[] {
  if (!state || typeof state !== 'object') return [];
  const trail = (state as { soundMapTrail?: unknown }).soundMapTrail;
  if (!Array.isArray(trail)) return [];
  return trail.filter((id): id is number => Number.isInteger(id) && id > 0).slice(-SOUND_MAP_TRAIL_LIMIT);
}

export function pushSoundMapTrail(trail: readonly number[], previousSeedId: number | null): number[] {
  if (!previousSeedId) return [...trail];
  return [...trail, previousSeedId].slice(-SOUND_MAP_TRAIL_LIMIT);
}

export interface SoundMapSeedSources {
  /** songId → last played time (the listening history). */
  lastPlayedAtBySongId?: ReadonlyMap<number, number>;
  /** Played song ids without timing (the IndexedDB index); used when the times are not loaded. */
  playedIds?: Iterable<number>;
  /** songId → star rating (0 = not rated). */
  ratings?: Readonly<Record<string, number>>;
  /** Songs saved in playlists, in display order. */
  playlistSongIds?: readonly number[];
  /** Songs that must not be used (hidden songs). */
  excludedIds?: ReadonlySet<number>;
}

/**
 * The starting song when the URL has none and nothing is playing:
 * the most recently played song → the highest-rated song → the first playlist song.
 */
export function pickSoundMapFallbackSeed(sources: SoundMapSeedSources): number | null {
  const usable = (id: number) => Number.isInteger(id) && id > 0 && !sources.excludedIds?.has(id);
  let recent: number | null = null;
  let recentAt = Number.NEGATIVE_INFINITY;
  for (const [id, playedAt] of sources.lastPlayedAtBySongId ?? []) {
    if (usable(id) && playedAt > recentAt) {
      recent = id;
      recentAt = playedAt;
    }
  }
  if (recent !== null) return recent;
  for (const id of sources.playedIds ?? []) {
    if (usable(id)) return id;
  }
  let rated: number | null = null;
  let bestRating = 0;
  for (const [key, rating] of Object.entries(sources.ratings ?? {})) {
    const id = Number(key);
    if (usable(id) && Number.isFinite(rating) && rating > bestRating) {
      rated = id;
      bestRating = rating;
    }
  }
  if (rated !== null) return rated;
  return sources.playlistSongIds?.find(usable) ?? null;
}
