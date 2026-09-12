import type { SoundMapPoint } from '../api/soundMap';

export type SoundMapViewport = { zoom: number; centerX: number; centerY: number };

export const DEFAULT_SOUND_MAP_VIEWPORT: SoundMapViewport = { zoom: 1, centerX: 0, centerY: 0 };

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
