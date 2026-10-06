import type { Song } from '../types/vocadb';

export interface HomeFeedSnapshot {
  songs: Song[];
  startupSongs: Song[];
  page: number;
  hasMore: boolean;
  recommendationReasons: Record<number, string>;
  scrollY: number;
  initialLoadPending: boolean;
  sourceContextKey: string;
}

const MAX_HOME_FEED_SNAPSHOTS = 5;
const snapshots = new Map<string, HomeFeedSnapshot>();

/** Keeps a small in-memory snapshot per browser history entry for Back navigation. */
export function getHomeFeedSnapshot(entryKey: string): HomeFeedSnapshot | undefined {
  const snapshot = snapshots.get(entryKey);
  if (!snapshot) return undefined;

  snapshots.delete(entryKey);
  snapshots.set(entryKey, snapshot);
  return snapshot;
}

export function saveHomeFeedSnapshot(entryKey: string, snapshot: HomeFeedSnapshot): void {
  snapshots.delete(entryKey);
  snapshots.set(entryKey, snapshot);

  while (snapshots.size > MAX_HOME_FEED_SNAPSHOTS) {
    const oldestEntryKey = snapshots.keys().next().value;
    if (oldestEntryKey === undefined) break;
    snapshots.delete(oldestEntryKey);
  }
}

export function updateHomeFeedSnapshotScroll(entryKey: string, scrollY: number): void {
  const snapshot = snapshots.get(entryKey);
  if (!snapshot) return;

  snapshot.scrollY = Math.max(0, scrollY);
}

export function clearHomeFeedSnapshot(entryKey: string): void {
  snapshots.delete(entryKey);
}
