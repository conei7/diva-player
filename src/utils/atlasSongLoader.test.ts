import { describe, expect, it, vi } from 'vitest';
import type { Song } from '../types/vocadb';
import { AtlasSongLoader } from './atlasSongLoader';

const song = (id: number) => ({ id, name: `Song ${id}` } as Song);
const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

describe('atlas viewport metadata', () => {
  it('keeps arriving names across movement, and replaces queued work with the latest viewport', async () => {
    const finishes: ((songs: Song[]) => void)[] = [];
    const fetch = vi.fn(() => new Promise<Song[]>(resolve => finishes.push(resolve)));
    const loader = new AtlasSongLoader(fetch);
    const notify = vi.fn(); loader.subscribe(notify);
    loader.request(Array.from({ length: 200 }, (_, i) => i + 1));
    expect(fetch).toHaveBeenCalledTimes(1);
    loader.request([999, 1]);
    finishes[0]([song(1)]); await settle();
    expect(loader.songs.get(1)?.name).toBe('Song 1');
    expect(fetch).toHaveBeenLastCalledWith([999]);
    finishes[1]([song(999)]); await settle();
    loader.request([1, 999]);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenCalledTimes(2);
  });
  it('does not refetch summary names, duplicates, or pending requests', async () => {
    let finish!: (songs: Song[]) => void;
    const fetch = vi.fn(() => new Promise<Song[]>(resolve => { finish = resolve; }));
    const loader = new AtlasSongLoader(fetch, [song(1)]);
    loader.request([1, 2, 2]); loader.request([2, 1]);
    expect(fetch).toHaveBeenCalledExactlyOnceWith([2]);
    finish([song(2)]); await settle();
    loader.request([1, 2]); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('bounds retained metadata and does not spin on unavailable songs', async () => {
    const fetch = vi.fn(async (ids: number[]) => ids.filter(id => id !== 999).map(song));
    const loader = new AtlasSongLoader(fetch, [], 4);
    for (let id = 1; id <= 12; id++) { loader.request([id]); await settle(); }
    expect(loader.songs.size).toBe(4);
    expect(loader.songs.has(12)).toBe(true);
    loader.request([999]); await settle(); loader.request([999]); await settle();
    expect(fetch.mock.calls.filter(([ids]) => ids.includes(999))).toHaveLength(1);
  });
});
