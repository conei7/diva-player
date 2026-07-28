import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Song } from '../types/vocadb';

let usePlayerStore: typeof import('./playerStore').usePlayerStore;

beforeAll(async () => {
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    get length() { return values.size; },
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
    key: (index: number) => [...values.keys()][index] ?? null,
  });
  ({ usePlayerStore } = await import('./playerStore'));
});

const song: Song = {
  id: 900001,
  name: 'Queue autoplay fixture',
  artistString: 'Fixture producer',
  createDate: '2026-01-01T00:00:00Z',
  defaultName: 'Queue autoplay fixture',
  defaultNameLanguage: 'English',
  favoritedTimes: 0,
  lengthSeconds: 30,
  pvs: [{
    author: '',
    disabled: false,
    id: 9000011,
    length: 30,
    name: 'fixture',
    pvId: 'fixture',
    service: 'Youtube',
    pvType: 'Original',
    url: 'https://youtu.be/fixture',
  }],
  pvServices: 'Youtube',
  ratingScore: 0,
  songType: 'Original',
  status: 'Finished',
  version: 1,
};

describe('player queue autoplay', () => {
  afterEach(() => {
    usePlayerStore.getState().closePlayer();
  });

  it('keeps a queue loaded but paused for a new-tab link', () => {
    usePlayerStore.getState().setQueue([song], 0, false);

    const state = usePlayerStore.getState();
    expect(state.currentSong?.id).toBe(song.id);
    expect(state.currentPV?.pvId).toBe('fixture');
    expect(state.queueIndex).toBe(0);
    expect(state.isPlaying).toBe(false);
  });

  it('continues to autoplay normal queue selection', () => {
    usePlayerStore.getState().setQueue([song], 0);
    expect(usePlayerStore.getState().isPlaying).toBe(true);
  });
});
