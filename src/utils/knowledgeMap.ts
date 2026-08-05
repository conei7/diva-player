import type { PlatformKnowledgeMap } from '../api/knowledgeMap';

export interface KnowledgeMapItem {
  id: string;
  songId?: number;
  label: string;
  secondaryLabel?: string;
  views: number;
  known: boolean;
  aggregate: boolean;
  thumbUrl?: string;
}

export interface KnowledgeMapRect extends KnowledgeMapItem {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function buildKnowledgeMapItems(data: PlatformKnowledgeMap): KnowledgeMapItem[] {
  const items: KnowledgeMapItem[] = data.tiles.map(tile => ({
    id: `song-${tile.songId}`,
    songId: tile.songId,
    label: tile.name,
    secondaryLabel: tile.artistString,
    views: tile.views,
    known: tile.known,
    aggregate: false,
    thumbUrl: tile.thumbUrl,
  }));
  if (data.knownRemainderViews > 0) {
    items.push({
      id: 'known-remainder',
      label: 'その他の知っている曲',
      views: data.knownRemainderViews,
      known: true,
      aggregate: true,
    });
  }
  if (data.unknownRemainderViews > 0) {
    items.push({
      id: 'unknown-remainder',
      label: 'その他の未再生曲',
      views: data.unknownRemainderViews,
      known: false,
      aggregate: true,
    });
  }
  return items
    .filter(item => Number.isFinite(item.views) && item.views > 0)
    .sort((left, right) => right.views - left.views || left.id.localeCompare(right.id));
}

export function layoutKnowledgeMap(items: readonly KnowledgeMapItem[]): KnowledgeMapRect[] {
  const normalized = items
    .filter(item => Number.isFinite(item.views) && item.views > 0)
    .sort((left, right) => right.views - left.views || left.id.localeCompare(right.id));
  if (normalized.length === 0) return [];

  const rectangles: KnowledgeMapRect[] = [];
  const place = (
    candidates: readonly KnowledgeMapItem[],
    x: number,
    y: number,
    width: number,
    height: number,
  ) => {
    if (candidates.length === 1) {
      rectangles.push({ ...candidates[0], x, y, width, height });
      return;
    }

    const total = candidates.reduce((sum, item) => sum + item.views, 0);
    let splitIndex = 1;
    let firstTotal = candidates[0].views;
    let bestDistance = Math.abs(total / 2 - firstTotal);
    for (let index = 1; index < candidates.length - 1; index += 1) {
      const nextTotal = firstTotal + candidates[index].views;
      const distance = Math.abs(total / 2 - nextTotal);
      if (distance > bestDistance) break;
      firstTotal = nextTotal;
      bestDistance = distance;
      splitIndex = index + 1;
    }

    const ratio = Math.max(0.000001, Math.min(0.999999, firstTotal / total));
    const first = candidates.slice(0, splitIndex);
    const second = candidates.slice(splitIndex);
    if (width >= height) {
      const firstWidth = width * ratio;
      place(first, x, y, firstWidth, height);
      place(second, x + firstWidth, y, width - firstWidth, height);
    } else {
      const firstHeight = height * ratio;
      place(first, x, y, width, firstHeight);
      place(second, x, y + firstHeight, width, height - firstHeight);
    }
  };

  place(normalized, 0, 0, 100, 100);
  return rectangles;
}
