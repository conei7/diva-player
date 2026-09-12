import type { SoundMapPoint } from '../api/soundMap';

export type SoundMapViewport = { zoom: number; centerX: number; centerY: number };

export const DEFAULT_SOUND_MAP_VIEWPORT: SoundMapViewport = { zoom: 1, centerX: 0, centerY: 0 };

export function clampSoundMapZoom(zoom: number): number {
  return Math.max(0.75, Math.min(5, zoom));
}

export function centerSoundMapOnPoint(point: Pick<SoundMapPoint, 'x' | 'y'>, zoom: number): SoundMapViewport {
  return { zoom: clampSoundMapZoom(zoom), centerX: point.x, centerY: point.y };
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
