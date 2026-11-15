import type { FavoriteProducer } from '../stores/favoriteProducerStore';
import type { Song } from '../types/vocadb';

/** Catalog publication days are compared with the JST calendar, including date-only releases. */
export function releaseCheckDay(timestamp: number): string {
  return new Date(timestamp + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export function followedCredits(song: Song, producers: readonly FavoriteProducer[]): FavoriteProducer[] {
  const ids = new Set((song.artists ?? []).filter(credit =>
    ['Producer', 'Band', 'Circle'].some(role => credit.categories?.includes(role)),
  ).map(credit => credit.artist?.id));
  return producers.filter(producer => ids.has(producer.id));
}

/** Use the catalog's publication date, never its ingestion date, for release notices. */
export function isUncheckedRelease(song: Song, producers: readonly FavoriteProducer[], now: number): boolean {
  const publishedAt = Date.parse(song.publishDate ?? '');
  const day = song.publishDate?.slice(0, 10) ?? '';
  return Number.isFinite(publishedAt) && day <= releaseCheckDay(now) && followedCredits(song, producers)
    .some(producer => {
      if (day < releaseCheckDay(producer.createdAt)) return false;
      if (producer.releasesCheckedAt === undefined) return true;
      const checkedDay = releaseCheckDay(producer.releasesCheckedAt);
      return day > checkedDay || (day === checkedDay && !producer.checkedReleaseIds?.includes(song.id));
    });
}

export function isPublishedFollowedRelease(song: Song, producers: readonly FavoriteProducer[], now: number): boolean {
  const publishedAt = Date.parse(song.publishDate ?? '');
  return Number.isFinite(publishedAt) && (song.publishDate?.slice(0, 10) ?? '') <= releaseCheckDay(now)
    && followedCredits(song, producers).length > 0;
}
