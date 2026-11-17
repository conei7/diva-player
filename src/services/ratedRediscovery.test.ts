import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Song } from '../types/vocadb';
import { DEFAULT_GLOBAL_FILTER_SETTINGS } from '../stores/globalFilterStore';
import { getRatedRediscoverySong, insertRatedRediscovery, REDISCOVERY_AGE_MS, sampleRatedRediscoveryIds, type RatedRediscoveryOptions } from './ratedRediscovery';

const api = vi.hoisted(() => ({ eligible: vi.fn(), songs: vi.fn(), views: vi.fn() }));
vi.mock('../api/vocadb', () => ({ getDiscoveryEligibleSongIds: api.eligible, getSongsByIds: api.songs, attachExternalViews: api.views }));
const now = Date.UTC(2026, 10, 18);
const song = (id: number) => ({ id, name: `Song ${id}`, songType: 'Original',
  artists: [{ categories: 'Vocalist', artist: { id: 1, artistType: 'Vocaloid' } }],
  pvs: [{ service: 'Youtube', disabled: false }],
}) as Song;
const options = (overrides: Partial<RatedRediscoveryOptions> = {}): RatedRediscoveryOptions => ({
  ratings: { 1: 5, 2: 4, 3: 3, 4: 2 },
  lastPlayedAtBySongId: new Map(), excludeIds: new Set(),
  settings: DEFAULT_GLOBAL_FILTER_SETTINGS, requestedCount: 12, now, random: () => 0.5,
  ...overrides,
});

beforeEach(() => {
  vi.resetAllMocks();
  api.eligible.mockImplementation(async (ids: number[]) => new Set(ids));
  api.songs.mockImplementation(async (ids: number[]) => ids.map(song));
  api.views.mockImplementation(async (songs: Song[]) => songs);
});

describe('rated rediscovery', () => {
  it('samples all rating IDs without requiring history or playlist cards, with bounded work', () => {
    const ids = sampleRatedRediscoveryIds(options({ ratings: Object.fromEntries(Array.from({ length: 5000 }, (_, i) => [i + 1, 5])) }));
    expect(ids).toHaveLength(12);
    expect(new Set(ids).size).toBe(12);
  });

  it('excludes one star, unset/malformed ratings, hidden/queued IDs and recently played songs', () => {
    const ids = sampleRatedRediscoveryIds(options({ ratings: { 1: 1, 2: 0, 3: 2, 4: 3, 5: 4, 6: 5, 7: 6, bad: 5, '-1': 5 },
      excludeIds: new Set([4]), lastPlayedAtBySongId: new Map([[5, now - 1], [6, now - REDISCOVERY_AGE_MS]]) }));
    expect(ids).toEqual([6, 3]);
  });

  it('gives each rating positive probability and weights 5/4/3/2 as 12/8/2/1', () => {
    let seed = 123;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
    const counts = [0, 0, 0, 0];
    for (let i = 0; i < 23000; i++) counts[sampleRatedRediscoveryIds(options({ random }))[0] - 1]++;
    for (const [i, expected] of [12000, 8000, 2000, 1000].entries()) {
      expect(counts[i]).toBeGreaterThan(expected * 0.9);
      expect(counts[i]).toBeLessThan(expected * 1.1);
    }
  });

  it('skips networking when the slot lottery loses, count is zero or rated songs are excluded', async () => {
    expect(await getRatedRediscoverySong(options({ random: () => 0.9 }))).toBeNull();
    expect(await getRatedRediscoverySong(options({ requestedCount: 0 }))).toBeNull();
    expect(await getRatedRediscoverySong(options({ settings: { ...DEFAULT_GLOBAL_FILTER_SETTINGS, excludeRatedFromDiscovery: true } }))).toBeNull();
    expect(api.eligible).not.toHaveBeenCalled();
  });

  it('scales the slot chance down for small refills', async () => {
    expect(await getRatedRediscoverySong(options({ requestedCount: 1, random: () => 0.1 }))).toBeNull();
    expect(api.eligible).not.toHaveBeenCalled();
  });

  it('rechecks authoritative eligibility and keeps weighted order if metadata is reordered or missing', async () => {
    api.eligible.mockResolvedValue(new Set([2, 3, 4]));
    api.songs.mockResolvedValue([song(4), song(3)]);
    expect((await getRatedRediscoverySong(options()))?.id).toBe(3);
    expect(api.songs).toHaveBeenCalledWith([2, 3, 4]);
  });

  it('never relaxes explicit song filters or cooldown longer than fourteen days', async () => {
    expect(await getRatedRediscoverySong(options({ settings: { ...DEFAULT_GLOBAL_FILTER_SETTINGS, enabled: true, excludedSongTypes: ['Original'] } }))).toBeNull();
    expect(await getRatedRediscoverySong(options({ ratings: { 1: 5 }, lastPlayedAtBySongId: new Map([[1, now - REDISCOVERY_AGE_MS]]),
      settings: { ...DEFAULT_GLOBAL_FILTER_SETTINGS, cooldownHours: 24 * 30 } }))).toBeNull();
  });

  it('loads views when required and rejects songs below the threshold', async () => {
    api.views.mockImplementation(async (songs: Song[]) => songs.map(s => ({ ...s, youtubeViews: s.id === 2 ? 1000 : 1 })));
    expect((await getRatedRediscoverySong(options({ settings: { ...DEFAULT_GLOBAL_FILTER_SETTINGS, enabled: true, minYoutubeViews: 100 } })))?.id).toBe(2);
    expect(api.views).toHaveBeenCalled();
  });

  it('rejects human vocals and disabled or missing playable videos', async () => {
    api.songs.mockResolvedValue([{ ...song(1), artists: [] }, { ...song(2), pvs: [] },
      { ...song(3), pvs: [{ service: 'Youtube', disabled: true }] }, song(4)]);
    expect((await getRatedRediscoverySong(options()))?.id).toBe(4);
  });

  it('fails closed on API errors and cancellation', async () => {
    api.eligible.mockRejectedValueOnce(new Error('offline'));
    expect(await getRatedRediscoverySong(options())).toBeNull();
    const controller = new AbortController();
    api.eligible.mockImplementationOnce(async (ids: number[]) => { controller.abort(); return new Set(ids); });
    expect(await getRatedRediscoverySong(options({ signal: controller.signal }))).toBeNull();
    expect(api.songs).not.toHaveBeenCalled();
  });

  it('inserts at a random position, deduplicates and keeps the queue size and ordinary relative order', () => {
    const ranked = [song(1), song(2), song(3), song(4)];
    expect(insertRatedRediscovery(ranked, song(5), 4, () => 0.5).map(s => s.id)).toEqual([1, 2, 5, 3]);
    expect(insertRatedRediscovery(ranked, song(2), 4, () => 0).map(s => s.id)).toEqual([2, 1, 3, 4]);
    expect(insertRatedRediscovery(ranked, null, 4)).toBe(ranked);
    expect(ranked.map(s => s.id)).toEqual([1, 2, 3, 4]);
  });
});
