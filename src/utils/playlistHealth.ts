import type { Song } from '../types/vocadb';
import { isPlayablePV } from './playablePV';

export type PlaylistHealthIssueKind =
  | 'duplicate'
  | 'no-pv'
  | 'all-pv-disabled'
  | 'no-playable-pv';

export interface PlaylistHealthEntry {
  index: number;
  song: Song;
  issues: PlaylistHealthIssueKind[];
}

export interface PlaylistHealthReport {
  totalSongs: number;
  entries: PlaylistHealthEntry[];
  counts: Record<PlaylistHealthIssueKind, number>;
}

/** Analyze a playlist without changing its contents. */
export function analyzePlaylistHealth(songs: Song[]): PlaylistHealthReport {
  const counts: Record<PlaylistHealthIssueKind, number> = {
    duplicate: 0,
    'no-pv': 0,
    'all-pv-disabled': 0,
    'no-playable-pv': 0,
  };
  const seenIds = new Set<number>();
  const entries: PlaylistHealthEntry[] = [];

  songs.forEach((song, index) => {
    const issues: PlaylistHealthIssueKind[] = [];
    if (seenIds.has(song.id)) issues.push('duplicate');
    seenIds.add(song.id);

    const pvs = song.pvs ?? [];
    if (pvs.length === 0) {
      issues.push('no-pv');
    } else {
      const enabledPvs = pvs.filter(pv => !pv.disabled);
      if (enabledPvs.length === 0) {
        issues.push('all-pv-disabled');
      } else if (!enabledPvs.some(isPlayablePV)) {
        issues.push('no-playable-pv');
      }
    }

    issues.forEach(issue => { counts[issue] += 1; });
    if (issues.length > 0) entries.push({ index, song, issues });
  });

  return { totalSongs: songs.length, entries, counts };
}

/** Source texts (translate with t()). */
export const PLAYLIST_HEALTH_ISSUE_LABELS: Record<PlaylistHealthIssueKind, string> = {
  duplicate: '重複',
  'no-pv': '動画なし',
  'all-pv-disabled': '動画が削除済み',
  'no-playable-pv': '再生できない動画',
};

export const PLAYLIST_HEALTH_ISSUE_ORDER: readonly PlaylistHealthIssueKind[] = [
  'duplicate',
  'no-pv',
  'all-pv-disabled',
  'no-playable-pv',
];

/** Counts for the one-line notice above the song list: songs that can't play, and extra copies. */
export function summarizePlaylistHealth(report: PlaylistHealthReport): { unplayable: number; duplicates: number } {
  const unplayable = report.entries.filter(entry => entry.issues.some(issue => issue !== 'duplicate')).length;
  return { unplayable, duplicates: report.counts.duplicate };
}
