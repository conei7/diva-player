/**
 * Shared layout and data helpers of the music layout's playlist track table
 * (TrackListHeader + TrackRow). The header and the rows use the same column classes so the
 * columns line up: fixed widths for #, 公開日, 再生時間 and ⋮, and the rest shared by タイトル and
 * プロデューサー. Columns hide by viewport (as asked: プロデューサー / 公開日 below 1024px, # / 再生時間
 * below 640px) and also when the table itself is narrow (container queries on the table), e.g.
 * next to the playlist hero column, the library and the 再生中 panel.
 */
import type { Song } from '../../../types/vocadb';
import type { SortKey } from '../../../stores/playlistStore';
import { getPlayablePV } from '../../../stores/playerStore';
import { artistPath, searchPath } from '../../../utils/routes';
import { formatClockDuration } from '../../../utils/songMeta';
import { getSongProducerLinks } from '../../search/songCardMeta';

/** Row height (px) for the virtualizer estimate; TrackRow is exactly this tall. */
export const TRACK_ROW_HEIGHT = 56;

/** What the first column holds: the number, a drag handle + number, or the selection checkbox. */
export type TrackLeadKind = 'number' | 'handle' | 'select';

/** Gaps and side padding shared by the header row and the track rows. */
export const TRACK_ROW_GRID = 'flex items-center gap-3 px-2 sm:gap-4';

/**
 * Column classes (width / visibility). `@max-[…]` are container queries on the table element
 * (it carries `@container`), so they follow the space the table really has.
 */
export const TRACK_COLUMN = {
  /** Number slot inside the # column (40px). */
  number: 'flex w-10 shrink-0 items-center justify-center max-sm:hidden @max-[25rem]:hidden',
  title: 'flex min-w-0 flex-[4_1_0%] items-center gap-3',
  producer: 'min-w-0 flex-[3_1_0%] max-lg:hidden @max-[40rem]:hidden',
  date: 'w-28 shrink-0 max-lg:hidden @max-[40rem]:hidden',
  duration: 'flex w-14 shrink-0 justify-end max-sm:hidden @max-[25rem]:hidden',
  actions: 'flex w-10 shrink-0 justify-end max-sm:w-11',
} as const;

/** The # column: only the number when nothing else is in it (then it hides with the number). */
export function trackLeadColumnClass(kind: TrackLeadKind): string {
  return kind === 'number'
    ? 'flex shrink-0 items-center max-sm:hidden @max-[25rem]:hidden'
    : 'flex shrink-0 items-center';
}

/** Seconds of the song: VocaDB's length, else the playable PV's (kept in saved playlists). */
export function getTrackDurationSeconds(song: Song): number {
  const seconds = song.lengthSeconds || getPlayablePV(song)?.length || 0;
  return Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
}

/** '3:45', or null when the length is unknown (shown as —). */
export function formatTrackDuration(song: Song): string | null {
  const seconds = getTrackDurationSeconds(song);
  return seconds > 0 ? formatClockDuration(seconds) : null;
}

export interface TrackProducerLink {
  name: string;
  href: string;
}

/** Credited producers with their page (artist page with an id, else a producer search). */
export function getTrackProducerLinks(song: Song): TrackProducerLink[] {
  return getSongProducerLinks(song).map(producer => ({
    name: producer.name,
    href: producer.id ? artistPath({ id: producer.id, name: producer.name }) : searchPath(producer.name, 'producer'),
  }));
}

/** Header columns that sort the list (the same keys as the 並べ替え menu). */
export type TrackSortColumn = 'number' | 'title' | 'producer' | 'date';

export const TRACK_SORT_KEYS: Record<TrackSortColumn, SortKey> = {
  number: 'addedOrder',
  title: 'name',
  producer: 'artist',
  date: 'publishDate',
};

/** Clicking a header: sort by it; clicking the active one again goes back to the manual order. */
export function nextTrackSortKey(column: TrackSortColumn, current: SortKey): SortKey {
  const key = TRACK_SORT_KEYS[column];
  return key === current ? 'addedOrder' : key;
}

/** aria-sort of a header (only the column the list is sorted by has one). */
export function trackAriaSort(column: TrackSortColumn, current: SortKey): 'ascending' | 'descending' | undefined {
  if (TRACK_SORT_KEYS[column] !== current) return undefined;
  return current === 'publishDate' ? 'descending' : 'ascending';
}
