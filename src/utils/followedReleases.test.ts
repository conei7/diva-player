import { describe, expect, it } from 'vitest';
import type { Song } from '../types/vocadb';
import type { FavoriteProducer } from '../stores/favoriteProducerStore';
import { isPublishedFollowedRelease, isUncheckedRelease, releaseCheckDay } from './followedReleases';

const now = Date.parse('2026-11-15T01:00:00+09:00');
const producer: FavoriteProducer = { id: 7, name: 'P', artistType: 'Producer', createdAt: Date.parse('2026-11-13T12:00:00+09:00') };
const song = (date: string | undefined, id = 10) => ({ id, publishDate: date,
  artists: [{ artist: { id: 7 }, categories: 'Producer' }] } as Song);

describe('followed releases', () => {
  it('recognizes a date-only release on the current JST day, including before 09:00', () => {
    expect(releaseCheckDay(now)).toBe('2026-11-15');
    expect(isPublishedFollowedRelease(song('2026-11-15T00:00:00Z'), [producer], now)).toBe(true);
    expect(isUncheckedRelease(song('2026-11-15T00:00:00Z'), [producer], now)).toBe(true);
    expect(isPublishedFollowedRelease(song('2026-11-16'), [producer], now)).toBe(false);
  });
  it('keeps unseen same-day songs new after acknowledging loaded songs', () => {
    const checked = { ...producer, releasesCheckedAt: now, checkedReleaseIds: [10] };
    expect(isUncheckedRelease(song('2026-11-15', 10), [checked], now)).toBe(false);
    expect(isUncheckedRelease(song('2026-11-15', 11), [checked], now)).toBe(true);
    expect(isUncheckedRelease(song('2026-11-14', 12), [checked], now)).toBe(false);
  });
  it('does not notify old catalog imports or treat missing publication dates as new', () => {
    expect(isUncheckedRelease(song('2026-11-12'), [producer], now)).toBe(false);
    expect(isPublishedFollowedRelease(song(undefined), [producer], now)).toBe(false);
    expect(isPublishedFollowedRelease(song('invalid'), [producer], now)).toBe(false);
  });
  it('requires a producer credit and honors any unchecked followed collaborator', () => {
    const illustration = { ...song('2026-11-15'), artists: [{ artist: { id: 7 }, categories: 'Illustrator' }] } as Song;
    expect(isPublishedFollowedRelease(illustration, [producer], now)).toBe(false);
    const checked = { ...producer, releasesCheckedAt: now, checkedReleaseIds: [10] };
    const other = { ...producer, id: 8 };
    const collaboration = { ...song('2026-11-15'), artists: [...song('').artists!, { artist: { id: 8 }, categories: 'Producer' }] } as Song;
    expect(isUncheckedRelease(collaboration, [checked, other], now)).toBe(true);
  });
});
