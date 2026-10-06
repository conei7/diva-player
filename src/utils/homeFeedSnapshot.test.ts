import { describe, expect, it } from 'vitest';
import {
  clearHomeFeedSnapshot,
  getHomeFeedSnapshot,
  saveHomeFeedSnapshot,
  updateHomeFeedSnapshotScroll,
  type HomeFeedSnapshot,
} from './homeFeedSnapshot';

function createSnapshot(id: number): HomeFeedSnapshot {
  return {
    songs: [{ id } as HomeFeedSnapshot['songs'][number]],
    startupSongs: [],
    page: 2,
    hasMore: true,
    recommendationReasons: { [id]: '推薦' },
    scrollY: 320,
    initialLoadPending: false,
    sourceContextKey: 'context',
  };
}

describe('home feed history snapshots', () => {
  it('restores the loaded songs, paging state, and reasons for the same history entry', () => {
    const key = `restore-${Date.now()}-${Math.random()}`;
    const snapshot = createSnapshot(42);

    saveHomeFeedSnapshot(key, snapshot);

    expect(getHomeFeedSnapshot(key)).toEqual(snapshot);
    clearHomeFeedSnapshot(key);
    expect(getHomeFeedSnapshot(key)).toBeUndefined();
  });

  it('updates scroll position without discarding the feed snapshot', () => {
    const key = `scroll-${Date.now()}-${Math.random()}`;
    saveHomeFeedSnapshot(key, createSnapshot(43));

    updateHomeFeedSnapshotScroll(key, 840);

    expect(getHomeFeedSnapshot(key)).toMatchObject({ songs: [{ id: 43 }], scrollY: 840 });
    clearHomeFeedSnapshot(key);
  });

  it('keeps history snapshots bounded and evicts the least recently used entry', () => {
    const prefix = `bounded-${Date.now()}-${Math.random()}`;
    const keys = Array.from({ length: 6 }, (_, index) => `${prefix}-${index}`);
    keys.forEach((key, index) => saveHomeFeedSnapshot(key, createSnapshot(index)));

    expect(getHomeFeedSnapshot(keys[0])).toBeUndefined();
    expect(getHomeFeedSnapshot(keys[1])).toBeDefined();
    keys.forEach(key => clearHomeFeedSnapshot(key));
  });
});
