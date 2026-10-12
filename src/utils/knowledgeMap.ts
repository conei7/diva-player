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

export const KNOWN_REMAINDER_ID = 'known-remainder';
export const UNKNOWN_REMAINDER_ID = 'unknown-remainder';
/** Song tiles drawn one by one; smaller songs are folded into the remainder tiles. */
export const KNOWLEDGE_MAP_MAX_SONG_TILES = 120;

const REMAINDER_LABELS = {
  [KNOWN_REMAINDER_ID]: 'その他の知っている曲',
  [UNKNOWN_REMAINDER_ID]: 'その他のまだ知らない曲',
} as const;

function byViews(left: KnowledgeMapItem, right: KnowledgeMapItem): number {
  return right.views - left.views || left.id.localeCompare(right.id);
}

function hasViews(item: KnowledgeMapItem): boolean {
  return Number.isFinite(item.views) && item.views > 0;
}

function remainderItem(known: boolean, views: number): KnowledgeMapItem {
  const id = known ? KNOWN_REMAINDER_ID : UNKNOWN_REMAINDER_ID;
  return { id, label: REMAINDER_LABELS[id], views, known, aggregate: true };
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
  if (data.knownRemainderViews > 0) items.push(remainderItem(true, data.knownRemainderViews));
  if (data.unknownRemainderViews > 0) items.push(remainderItem(false, data.unknownRemainderViews));
  return items.filter(hasViews).sort(byViews);
}

/**
 * Keeps the `maxSongTiles` largest song tiles and adds the views of the rest to the
 * known / unknown remainder tiles, so the total area (and each side's share) is unchanged.
 */
export function capKnowledgeMapSongTiles(
  items: readonly KnowledgeMapItem[],
  maxSongTiles = KNOWLEDGE_MAP_MAX_SONG_TILES,
): KnowledgeMapItem[] {
  const valid = items.filter(hasViews);
  const songs = valid.filter(item => !item.aggregate).sort(byViews);
  const limit = Math.max(0, Math.floor(maxSongTiles));
  if (songs.length <= limit) return [...valid].sort(byViews);

  const aggregates = valid.filter(item => item.aggregate).map(item => ({ ...item }));
  const fold = (known: boolean, views: number) => {
    if (views <= 0) return;
    const existing = aggregates.find(item => item.known === known);
    if (existing) existing.views += views;
    else aggregates.push(remainderItem(known, views));
  };
  const overflow = songs.slice(limit);
  fold(true, overflow.filter(item => item.known).reduce((sum, item) => sum + item.views, 0));
  fold(false, overflow.filter(item => !item.known).reduce((sum, item) => sum + item.views, 0));
  return [...songs.slice(0, limit), ...aggregates].sort(byViews);
}

/**
 * Song tiles go in the treemap; the remainder buckets ("other songs") go in a band under it, so a
 * huge remainder can't squeeze the songs into a strip. Remainders are known first (like the chips).
 * With no song tile left (a filter that keeps only a remainder) the remainders fill the map instead.
 */
export function splitKnowledgeMapRemainders(items: readonly KnowledgeMapItem[]): {
  tiles: KnowledgeMapItem[];
  remainders: KnowledgeMapItem[];
} {
  const valid = items.filter(hasViews).sort(byViews);
  const songs = valid.filter(item => !item.aggregate);
  const remainders = valid
    .filter(item => item.aggregate)
    .sort((left, right) => Number(right.known) - Number(left.known));
  return songs.length > 0 ? { tiles: songs, remainders } : { tiles: remainders, remainders: [] };
}

/** A share of the views: one decimal, two under 1% (so a small share doesn't read as 0.0%). */
export function formatKnowledgePercent(ratio: number): string {
  const percent = Math.max(0, Math.min(1, Number.isFinite(ratio) ? ratio : 0)) * 100;
  return `${percent < 1 && percent > 0 ? percent.toFixed(2) : percent.toFixed(1)}%`;
}

/**
 * Binary treemap in percent coordinates (0–100 on both axes). `aspectRatio` is the container's
 * width / height, so each split cuts the longer side of the real (pixel) rectangle.
 */
export function layoutKnowledgeMap(items: readonly KnowledgeMapItem[], aspectRatio = 1): KnowledgeMapRect[] {
  const normalized = items.filter(hasViews).sort(byViews);
  if (normalized.length === 0) return [];
  const widthScale = Number.isFinite(aspectRatio) && aspectRatio > 0 ? aspectRatio : 1;

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
    if (width * widthScale >= height) {
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
