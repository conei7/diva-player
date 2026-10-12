import { describe, expect, it } from 'vitest';
import type { ArtistForSong } from '../../types/vocadb';
import { buildCreditGroups, formatCalendarDate, formatExactViewCount } from './watchFormat';

function artist(id: number, name: string, categories: string, roles = 'Default'): ArtistForSong {
  return {
    artist: { id, name } as ArtistForSong['artist'],
    categories: categories as ArtistForSong['categories'],
    effectiveRoles: roles,
    id,
    isCustomName: false,
    isSupport: false,
    name,
    roles,
  };
}

describe('formatExactViewCount', () => {
  it('groups digits and handles the singular in English', () => {
    expect(formatExactViewCount(44709123, 'ja')).toBe('44,709,123回再生');
    expect(formatExactViewCount(44709123, 'en')).toBe('44,709,123 views');
    expect(formatExactViewCount(1, 'en')).toBe('1 view');
  });
});

describe('formatCalendarDate', () => {
  it('formats the written calendar date without a time-zone shift', () => {
    expect(formatCalendarDate('2010-02-14T00:00:00', 'ja')).toBe('2010年2月14日');
    expect(formatCalendarDate('2010-02-14T00:00:00Z', 'en')).toBe('Feb 14, 2010');
  });

  it('returns null for missing or invalid dates', () => {
    expect(formatCalendarDate(undefined, 'ja')).toBeNull();
    expect(formatCalendarDate('not a date', 'ja')).toBeNull();
  });
});

describe('buildCreditGroups', () => {
  it('groups producers, vocalists and the other roles with role-aware links', () => {
    const groups = buildCreditGroups({
      artists: [
        artist(1, 'wowaka', 'Producer'),
        artist(2, '初音ミク', 'Vocalist'),
        artist(3, 'Illustrator A', 'Illustrator', 'Illustrator'),
        artist(4, 'Writer B', 'Other', 'Lyricist'),
        artist(5, 'Default C', 'Animator'),
      ],
    });

    expect(groups.map(group => group.role)).toEqual(['producer', 'vocalist', 'Lyricist', 'Illustrator', 'Animator']);
    expect(groups[0].people[0].href).toBe('/?artistId=1&artistName=wowaka');
    expect(groups[3].people[0].href).toBe('/?artistId=3&artistRole=Illustrator&artistName=Illustrator%20A');
  });
});
