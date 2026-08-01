import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Song } from '../types/vocadb';

let usePlayerStore: typeof import('./playerStore').usePlayerStore;
let getPlayablePV: typeof import('./playerStore').getPlayablePV;

beforeAll(async () => {
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    get length() { return values.size; },
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
    key: (index: number) => [...values.keys()][index] ?? null,
  });
  ({ usePlayerStore, getPlayablePV } = await import('./playerStore'));
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

  it('preserves discovery as the playback source while starting the queue', () => {
    usePlayerStore.getState().setQueue([song], 0, true, 'discovery', '発掘ミックス');
    const state = usePlayerStore.getState();
    expect(state.isPlaying).toBe(true);
    expect(state.currentPlaybackSource).toBe('discovery');
    expect(state.queueSources).toEqual(['discovery']);
    expect(state.queueTitle).toBe('発掘ミックス');
  });

  it('restores a removed queue item at its original position without changing the source title', () => {
    const second = { ...song, id: song.id + 1, name: 'Second queue fixture' };
    usePlayerStore.getState().setQueue([song, second], 0, false, 'manual', 'お気に入り曲');

    const removed = usePlayerStore.getState().removeFromQueue(1);
    expect(usePlayerStore.getState().queue.map(item => item.id)).toEqual([song.id]);
    expect(removed).not.toBeNull();

    usePlayerStore.getState().restoreQueueItem(removed!);
    const state = usePlayerStore.getState();
    expect(state.queue.map(item => item.id)).toEqual([song.id, second.id]);
    expect(state.queueTitle).toBe('お気に入り曲');
  });

  it('continues with the previous song when removing the current last queue item', () => {
    const second = { ...song, id: song.id + 1, name: 'Second queue fixture' };
    usePlayerStore.getState().setQueue([song, second], 1, false, 'manual', 'テストプレイリスト');

    usePlayerStore.getState().removeFromQueue(1);
    const state = usePlayerStore.getState();
    expect(state.queue.map(item => item.id)).toEqual([song.id]);
    expect(state.queueIndex).toBe(0);
    expect(state.currentSong?.id).toBe(song.id);
  });

  it('keeps existing services ahead of SoundCloud and Bilibili in auto mode', () => {
    const result = getPlayablePV({
      ...song,
      pvs: [
        { ...song.pvs![0], id: 2, pvId: 'bili', service: 'Bilibili' },
        { ...song.pvs![0], id: 3, pvId: 'soundcloud', service: 'SoundCloud' },
        song.pvs![0],
      ],
    });
    expect(result?.service).toBe('Youtube');
  });

  it('prefers an official NicoNico PV over a YouTube reprint in auto mode', () => {
    const result = getPlayablePV({
      ...song,
      pvs: [
        { ...song.pvs![0], id: 2, pvId: 'youtube-reprint', pvType: 'Reprint' },
        { ...song.pvs![0], id: 3, pvId: 'nico-original', service: 'NicoNicoDouga', pvType: 'Original' },
      ],
    });
    expect(result?.service).toBe('NicoNicoDouga');
    expect(result?.pvType).toBe('Original');
  });

  it('uses YouTube when both YouTube and NicoNico have official PVs in auto mode', () => {
    const result = getPlayablePV({
      ...song,
      pvs: [
        { ...song.pvs![0], id: 2, pvId: 'nico-original', service: 'NicoNicoDouga' },
        { ...song.pvs![0], id: 3, pvId: 'youtube-original' },
      ],
    });
    expect(result?.service).toBe('Youtube');
    expect(result?.pvType).toBe('Original');
  });

  it('plays a SoundCloud-only or Bilibili-only song', () => {
    expect(getPlayablePV({
      ...song,
      pvs: [{ ...song.pvs![0], pvId: '103524583 producer/track', service: 'SoundCloud' }],
    })?.service).toBe('SoundCloud');
    expect(getPlayablePV({
      ...song,
      pvs: [{ ...song.pvs![0], pvId: '45451154', service: 'Bilibili' }],
    })?.service).toBe('Bilibili');
  });
});
