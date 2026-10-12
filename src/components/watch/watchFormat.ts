/**
 * Text helpers for the watch page that need the language (not translation strings):
 * exact view counts in the expanded description and calendar dates.
 */
import type { AppLanguage } from '../../stores/languageStore';
import type { ArtistForSong, Song } from '../../types/vocadb';

/** '44,709,123回再生' / '44,709,123 views' / '1 view'. */
export function formatExactViewCount(count: number, language: AppLanguage): string {
  const value = Number.isFinite(count) && count > 0 ? Math.round(count) : 0;
  if (language === 'ja') return `${value.toLocaleString('ja-JP')}回再生`;
  return value === 1 ? '1 view' : `${value.toLocaleString('en-US')} views`;
}

/** '2010年2月14日' / 'Feb 14, 2010'. Uses the calendar date as written (no time-zone shift). */
export function formatCalendarDate(date: string | undefined, language: AppLanguage): string | null {
  if (!date) return null;
  const match = date.match(/^(\d{4})-(\d{2})-(\d{2})/);
  const timestamp = match
    ? Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
    : Date.parse(date);
  if (Number.isNaN(timestamp)) return null;
  return new Intl.DateTimeFormat(language === 'ja' ? 'ja-JP' : 'en-US', {
    year: 'numeric',
    month: language === 'ja' ? 'long' : 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(timestamp));
}

export interface CreditPerson {
  key: string;
  name: string;
  /** Song list of the artist (with the role for non-producer credits); null when there is nothing to link to. */
  href: string | null;
}

export interface CreditGroup {
  /** 'producer' / 'vocalist' or a VocaDB role name ('Illustrator', 'Lyricist'…). */
  role: string;
  people: CreditPerson[];
}

const CREDIT_CATEGORIES = ['Illustrator', 'Animator', 'Composer', 'Lyricist', 'Instrumentalist', 'Other'];
const ROLE_ORDER = [
  'Composer', 'Lyricist', 'Arranger', 'Mixer', 'Mastering', 'Instrumentalist', 'VoiceManipulator',
  'Chorus', 'Illustrator', 'Animator', 'Encoder', 'Publisher', 'Distributor', 'VocalDataProvider', 'Other',
];

function artistName(artist: ArtistForSong): string {
  return (artist.name || artist.artist?.name || '').trim();
}

function artistHref(artist: ArtistForSong, role?: string): string | null {
  const name = artistName(artist);
  const id = artist.artist?.id;
  if (id) {
    const base = `/?artistId=${id}&artistName=${encodeURIComponent(name)}`;
    return role ? `/?artistId=${id}&artistRole=${encodeURIComponent(role)}&artistName=${encodeURIComponent(name)}` : base;
  }
  return name ? `/?q=${encodeURIComponent(name)}` : null;
}

function rolesOf(artist: ArtistForSong): string[] {
  const split = (value: string | undefined) => (value ?? '').split(',').map(role => role.trim())
    .filter(role => role && !['Default', 'Producer', 'Vocalist'].includes(role));
  const roles = split(artist.roles || artist.effectiveRoles);
  if (roles.length > 0) return roles;
  const fromCategories = split(artist.categories);
  return fromCategories.length > 0 ? fromCategories : ['Other'];
}

/** Credits grouped by role: producers, vocalists, then the other roles (illustration, lyrics…). */
export function buildCreditGroups(song: Pick<Song, 'artists'>): CreditGroup[] {
  const artists = song.artists ?? [];
  const groups: CreditGroup[] = [];
  const producers = artists.filter(artist => artist.categories?.includes('Producer') && artistName(artist));
  if (producers.length > 0) {
    groups.push({
      role: 'producer',
      people: producers.map(artist => ({ key: `p-${artist.id}`, name: artistName(artist), href: artistHref(artist) })),
    });
  }
  const vocalists = artists.filter(artist => artist.categories === 'Vocalist' && artistName(artist));
  if (vocalists.length > 0) {
    groups.push({
      role: 'vocalist',
      people: vocalists.map(artist => ({ key: `v-${artist.id}`, name: artistName(artist), href: artistHref(artist) })),
    });
  }
  const byRole = new Map<string, CreditPerson[]>();
  for (const artist of artists) {
    const categories = artist.categories || '';
    if (categories.includes('Vocalist') || categories.includes('Producer')) continue;
    if (!CREDIT_CATEGORIES.some(category => categories.includes(category))) continue;
    const name = artistName(artist);
    if (!name) continue;
    for (const role of rolesOf(artist)) {
      const people = byRole.get(role) ?? [];
      people.push({ key: `${role}-${artist.id}`, name, href: artistHref(artist, role) });
      byRole.set(role, people);
    }
  }
  const rank = (role: string) => {
    const index = ROLE_ORDER.indexOf(role);
    return index < 0 ? ROLE_ORDER.length : index;
  };
  [...byRole.entries()]
    .sort(([a], [b]) => rank(a) - rank(b))
    .forEach(([role, people]) => groups.push({ role, people }));
  return groups;
}
