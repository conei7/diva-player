import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { QueueContinuation } from '../stores/playerStore';
import { normalizeQueueContinuation } from '../stores/playerStore';
import type { Song } from '../types/vocadb';

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), songs: vi.fn() }));
vi.mock('../api/soundMap', () => ({ fetchGroupSoundMap: mocks.fetch }));
vi.mock('../api/vocadb', () => ({ getSongsByIds: mocks.songs }));
import { nextGroupSoundMapQueueSongs, rememberGroupSoundMapQueueSongs, resetGroupSoundMapQueueForTests } from './groupSoundMapQueue';

const group: Extract<QueueContinuation, { kind: 'groupSoundMap' }> = {
  kind: 'groupSoundMap', songIds: [1, 2, 3], mapVersion: 'map-v1', axisKey: '2:570:457',
};
const range = (start: number, n: number) => Array.from({ length: n }, (_, i) => start + i);
const song = (id: number, playable = true) => ({ id, pvs: playable
  ? [{ service: 'Youtube', pvId: `pv${id}`, disabled: false }] : [] }) as Song;
const options = (excludeIds = new Set<number>(), count = 12) => ({
  continuation: group, excludeIds, count, signal: new AbortController().signal,
});

describe('group map queue continuation', () => {
  beforeEach(() => {
    resetGroupSoundMapQueueForTests();
    mocks.fetch.mockReset().mockImplementation(async (_ids, opts) => ({
      mapVersion: 'map-v1', axisSelectionVersion: 2, axes: { x: 570, y: 457 },
      nearby: range(100 + opts.nearbyOffset, 200).map(songId => ({ songId })),
      nearbyNextOffset: opts.nearbyOffset + 200, nearbyHasMore: opts.nearbyOffset < 400,
    }));
    mocks.songs.mockReset().mockImplementation(async ids => ids.map((id: number) => song(id)));
  });

  it('continues past the first 20 rows and beyond 200, preserving the original group and axes', async () => {
    expect((await nextGroupSoundMapQueueSongs(options(new Set(range(100, 20))))).map(s => s.id)).toEqual(range(120, 12));
    expect((await nextGroupSoundMapQueueSongs(options(new Set(range(100, 205))))).map(s => s.id)).toEqual(range(305, 12));
    expect(mocks.fetch).toHaveBeenLastCalledWith([1, 2, 3], expect.objectContaining({
      nearbyOffset: 200, nearbyLimit: 200, nearbyOnly: true, axisKey: '2:570:457', mapVersion: 'map-v1',
    }));
  });

  it('skips hidden / queued / unplayable songs and consumes only committed appends', async () => {
    mocks.songs.mockImplementation(async ids => ids.map((id: number) => song(id, id !== 101)));
    const first = await nextGroupSoundMapQueueSongs(options(new Set([100]), 3));
    expect(first.map(s => s.id)).toEqual([102, 103, 104]);
    expect((await nextGroupSoundMapQueueSongs(options(new Set([100]), 3))).map(s => s.id)).toEqual([102, 103, 104]);
    rememberGroupSoundMapQueueSongs(group, first);
    expect((await nextGroupSoundMapQueueSongs(options(new Set([100]), 3))).map(s => s.id)).toEqual([105, 106, 107]);
  });

  it('resumes from a saved queue after a page reload without a hidden in-memory cursor', async () => {
    const continuation = normalizeQueueContinuation(JSON.parse(JSON.stringify(group)));
    expect(continuation).toEqual(group);
    expect((await nextGroupSoundMapQueueSongs(options(new Set(range(100, 240))))).map(s => s.id)).toEqual(range(340, 12));
    resetGroupSoundMapQueueForTests();
    expect((await nextGroupSoundMapQueueSongs(options(new Set(range(100, 252))))).map(s => s.id)).toEqual(range(352, 12));
  });

  it('does not consume aborted fetches and retries failures without ordinary recommendation fallback', async () => {
    const opts = options();
    const controller = new AbortController();
    mocks.fetch.mockImplementationOnce(async () => { controller.abort(); return {}; });
    await expect(nextGroupSoundMapQueueSongs({ ...opts, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    mocks.fetch.mockRejectedValueOnce(new Error('offline'));
    await expect(nextGroupSoundMapQueueSongs(opts)).rejects.toThrow('offline');
    expect((await nextGroupSoundMapQueueSongs(opts)).map(s => s.id)).toEqual(range(100, 12));
  });

  it('stops at the end and rejects stale axes / missing pagination instead of silently switching modes', async () => {
    expect(await nextGroupSoundMapQueueSongs(options(new Set(range(100, 600))))).toEqual([]);
    resetGroupSoundMapQueueForTests();
    mocks.fetch.mockResolvedValueOnce({ mapVersion: 'map-v1' });
    await expect(nextGroupSoundMapQueueSongs(options())).rejects.toThrow('contract changed');
  });

  it('rejects malformed persisted groups but retains the old single-origin format', () => {
    expect(normalizeQueueContinuation({ kind: 'soundMap', originSongId: 42 })).toEqual({ kind: 'soundMap', originSongId: 42 });
    for (const invalid of [{ ...group, songIds: [1, 1, 2] }, { ...group, songIds: [1, 2] },
      { ...group, axisKey: '2:1024:457' }, { ...group, axisKey: '2:1:1' }, { ...group, mapVersion: '' }]) {
      expect(normalizeQueueContinuation(invalid)).toBeNull();
    }
  });
});
