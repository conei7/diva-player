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

  it('rejects a delayed automatic queue append after the player closes', () => {
    const delayedSong = { ...song, id: song.id + 1, name: 'Delayed auto fixture' };
    usePlayerStore.getState().setQueue([song], 0);
    const { currentSong, playbackSequence } = usePlayerStore.getState();
    const expectedPlayback = { currentSongId: currentSong!.id, playbackSequence };

    usePlayerStore.getState().closePlayer();
    const appendApplied = usePlayerStore.getState().addManyToQueue(
      [delayedSong],
      'auto',
      expectedPlayback,
    );

    expect(appendApplied).toBe(false);
    expect(usePlayerStore.getState().queue).toEqual([]);
    expect(localStorage.getItem('diva_playerQueue')).toBeNull();
  });

  it('rejects a delayed automatic queue append after playback switches songs', () => {
    const second = { ...song, id: song.id + 1, name: 'Second queue fixture' };
    const delayedSong = { ...song, id: song.id + 2, name: 'Delayed auto fixture' };
    usePlayerStore.getState().setQueue([song, second], 0);
    const { currentSong, playbackSequence } = usePlayerStore.getState();
    const expectedPlayback = { currentSongId: currentSong!.id, playbackSequence };

    usePlayerStore.getState().jumpToIndex(1);
    const appendApplied = usePlayerStore.getState().addManyToQueue(
      [delayedSong],
      'auto',
      expectedPlayback,
    );

    expect(appendApplied).toBe(false);
    expect(usePlayerStore.getState().currentSong?.id).toBe(second.id);
    expect(usePlayerStore.getState().queue.map(item => item.id)).toEqual([song.id, second.id]);
    const stored = JSON.parse(localStorage.getItem('diva_playerQueue') ?? '{}') as { songIds?: number[] };
    expect(stored.songIds).toEqual([song.id, second.id]);
  });

  it('rejects a delayed automatic queue append after the same song restarts', () => {
    const delayedSong = { ...song, id: song.id + 1, name: 'Delayed auto fixture' };
    usePlayerStore.getState().setQueue([song], 0);
    const { currentSong, playbackSequence } = usePlayerStore.getState();
    const expectedPlayback = { currentSongId: currentSong!.id, playbackSequence };

    usePlayerStore.getState().playSong(song, true);
    expect(usePlayerStore.getState().currentSong?.id).toBe(expectedPlayback.currentSongId);
    expect(usePlayerStore.getState().playbackSequence).toBeGreaterThan(playbackSequence);

    const appendApplied = usePlayerStore.getState().addManyToQueue(
      [delayedSong],
      'auto',
      expectedPlayback,
    );

    expect(appendApplied).toBe(false);
    expect(usePlayerStore.getState().queue.map(item => item.id)).toEqual([song.id]);
  });

  it('persists the user-selected root seed with the queue', () => {
    usePlayerStore.getState().setQueue([song], 0);

    const stored = JSON.parse(localStorage.getItem('diva_playerQueue') ?? '{}') as { rootSeedId?: number };
    expect(usePlayerStore.getState().rootSeed?.id).toBe(song.id);
    expect(stored.rootSeedId).toBe(song.id);
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

  it('uses the official YouTube PV for コバルトメモリーズ and ignores legacy hidden-tab failures', () => {
    localStorage.setItem('diva_failedPVs', JSON.stringify({
      '167789': { 'Youtube:0X_pI_SCDK8': Date.now() },
    }));
    const result = getPlayablePV({
      ...song,
      id: 167789,
      name: 'コバルトメモリーズ',
      pvs: [
        { ...song.pvs![0], id: 243038, pvId: 'sm31936023', service: 'NicoNicoDouga', name: 'コバルトメモリーズ / 初音ミク アニメMV' },
        { ...song.pvs![0], id: 243059, pvId: '0X_pI_SCDK8', service: 'Youtube', name: 'コバルトメモリーズ / はるまきごはん feat.初音ミク アニメMV' },
      ],
    });
    expect(result?.service).toBe('Youtube');
    expect(result?.pvId).toBe('0X_pI_SCDK8');
  });

  it('still falls back to the official NicoNico PV after a current explicit YouTube failure', () => {
    localStorage.setItem('diva_failedPVsV2', JSON.stringify({
      '167789': { 'Youtube:0X_pI_SCDK8': Date.now() },
    }));
    const result = getPlayablePV({
      ...song,
      id: 167789,
      name: 'コバルトメモリーズ',
      pvs: [
        { ...song.pvs![0], id: 243038, pvId: 'sm31936023', service: 'NicoNicoDouga' },
        { ...song.pvs![0], id: 243059, pvId: '0X_pI_SCDK8', service: 'Youtube' },
      ],
    });
    expect(result?.service).toBe('NicoNicoDouga');
    localStorage.removeItem('diva_failedPVsV2');
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
