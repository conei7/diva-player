import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Song } from '../types/vocadb';

let usePlayerStore: typeof import('./playerStore').usePlayerStore;
let getPlayablePV: typeof import('./playerStore').getPlayablePV;
let DEFAULT_VOLUME: typeof import('./playerStore').DEFAULT_VOLUME;
const localStorageValues = new Map<string, string>();

beforeAll(async () => {
  vi.stubGlobal('localStorage', {
    get length() { return localStorageValues.size; },
    getItem: (key: string) => localStorageValues.get(key) ?? null,
    setItem: (key: string, value: string) => { localStorageValues.set(key, value); },
    removeItem: (key: string) => { localStorageValues.delete(key); },
    key: (index: number) => [...localStorageValues.keys()][index] ?? null,
  });
  ({ usePlayerStore, getPlayablePV, DEFAULT_VOLUME } = await import('./playerStore'));
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

  it('keeps a new hidden YouTube tab paused but lets the active queue continue', () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
    const documentState = { visibilityState: 'hidden' };
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: documentState,
    });
    try {
      const nextSong = { ...song, id: song.id + 1, name: 'Queue continuation fixture' };
      usePlayerStore.getState().setQueue([song, nextSong], 0, false);
      expect(usePlayerStore.getState().currentSong?.id).toBe(song.id);
      expect(usePlayerStore.getState().isPlaying).toBe(false);

      usePlayerStore.getState().resume();
      usePlayerStore.getState().setIsPlaying(true);
      expect(usePlayerStore.getState().isPlaying).toBe(false);

      documentState.visibilityState = 'visible';
      usePlayerStore.getState().setQueue([song, nextSong], 0, true);
      expect(usePlayerStore.getState().isPlaying).toBe(true);

      documentState.visibilityState = 'hidden';
      usePlayerStore.getState().next();
      expect(usePlayerStore.getState().currentSong?.id).toBe(nextSong.id);
      expect(usePlayerStore.getState().isPlaying).toBe(true);
      usePlayerStore.getState().setIsPlaying(true);
      expect(usePlayerStore.getState().isPlaying).toBe(true);
    } finally {
      if (descriptor) Object.defineProperty(globalThis, 'document', descriptor);
      else Reflect.deleteProperty(globalThis, 'document');
    }
  });

  it('pauses hidden queue continuation when the next PV is Niconico', () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: { visibilityState: 'visible' },
    });
    try {
      const nicoSong: Song = {
        ...song,
        id: song.id + 2,
        name: 'Niconico queue continuation fixture',
        pvs: [{
          ...song.pvs![0],
          id: song.pvs![0].id + 1,
          pvId: 'nico-fixture',
          service: 'NicoNicoDouga',
          url: 'https://www.nicovideo.jp/watch/nico-fixture',
        }],
        pvServices: 'NicoNicoDouga',
      };
      usePlayerStore.getState().setQueue([song, nicoSong], 0, true);
      expect(usePlayerStore.getState().isPlaying).toBe(true);

      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
      usePlayerStore.getState().next();

      expect(usePlayerStore.getState().currentSong?.id).toBe(nicoSong.id);
      expect(usePlayerStore.getState().currentPV?.service).toBe('NicoNicoDouga');
      expect(usePlayerStore.getState().isPlaying).toBe(false);
      usePlayerStore.getState().resume();
      usePlayerStore.getState().setIsPlaying(true);
      expect(usePlayerStore.getState().isPlaying).toBe(false);
    } finally {
      if (descriptor) Object.defineProperty(globalThis, 'document', descriptor);
      else Reflect.deleteProperty(globalThis, 'document');
    }
  });

  it('preserves hidden SoundCloud playback behavior', () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: { visibilityState: 'hidden' },
    });
    try {
      const soundCloudSong: Song = {
        ...song,
        id: song.id + 3,
        name: 'SoundCloud hidden playback fixture',
        pvs: [{
          ...song.pvs![0],
          id: song.pvs![0].id + 2,
          pvId: 'fixture/hidden-soundcloud',
          service: 'SoundCloud',
          url: 'https://soundcloud.com/fixture/hidden-soundcloud',
        }],
        pvServices: 'SoundCloud',
      };
      usePlayerStore.getState().setQueue([soundCloudSong], 0, true);
      expect(usePlayerStore.getState().currentPV?.service).toBe('SoundCloud');
      expect(usePlayerStore.getState().isPlaying).toBe(true);

      usePlayerStore.getState().pause();
      usePlayerStore.getState().resume();
      expect(usePlayerStore.getState().isPlaying).toBe(true);
    } finally {
      if (descriptor) Object.defineProperty(globalThis, 'document', descriptor);
      else Reflect.deleteProperty(globalThis, 'document');
    }
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

  it('gives an automatic PV fallback a new playback generation', () => {
    const fallbackSong: Song = {
      ...song,
      id: song.id + 20,
      pvs: [
        { ...song.pvs![0], id: 10, pvId: 'youtube-original' },
        { ...song.pvs![0], id: 11, pvId: 'nico-original', service: 'NicoNicoDouga' },
      ],
    };
    usePlayerStore.getState().setQueue([fallbackSong], 0);
    const before = usePlayerStore.getState().playbackSequence;

    usePlayerStore.getState().tryNextPV();

    expect(usePlayerStore.getState().currentPV?.pvId).toBe('nico-original');
    expect(usePlayerStore.getState().playbackSequence).toBe(before + 1);
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

describe('songs the user queues', () => {
  const a = song;
  const b = { ...song, id: song.id + 10, name: 'Queued B' };
  const c = { ...song, id: song.id + 11, name: 'Queued C' };
  const x = { ...song, id: song.id + 20, name: 'Autoplay X' };
  const y = { ...song, id: song.id + 21, name: 'Autoplay Y' };
  const ids = () => usePlayerStore.getState().queue.map(item => item.id);

  afterEach(() => {
    usePlayerStore.getState().closePlayer();
  });

  function playWithAutoplay(songs: Song[], autoSongs: Song[]) {
    usePlayerStore.getState().setQueue(songs, 0);
    const { currentSong, playbackSequence } = usePlayerStore.getState();
    expect(usePlayerStore.getState().addManyToQueue(autoSongs, 'auto', {
      currentSongId: currentSong!.id,
      playbackSequence,
    })).toBe(true);
  }

  it('go before the autoplay songs, after earlier additions', () => {
    playWithAutoplay([a], [x, y]);

    usePlayerStore.getState().addToQueue(b);
    expect(ids()).toEqual([a.id, b.id, x.id, y.id]);
    usePlayerStore.getState().addToQueue(c);
    expect(ids()).toEqual([a.id, b.id, c.id, x.id, y.id]);

    const state = usePlayerStore.getState();
    expect(state.queueSources).toEqual(['manual', 'manual', 'manual', 'auto', 'auto']);
    expect(state.queueIndex).toBe(0);
    expect(state.currentSong?.id).toBe(a.id);
    const stored = JSON.parse(localStorage.getItem('diva_playerQueue') ?? '{}') as {
      songIds?: number[];
      queueSources?: string[];
    };
    expect(stored.songIds).toEqual(ids());
    expect(stored.queueSources).toEqual(state.queueSources);
  });

  it('play right after an autoplay song that is playing', () => {
    playWithAutoplay([a], [x, y]);
    usePlayerStore.getState().next();
    expect(usePlayerStore.getState().currentSong?.id).toBe(x.id);

    usePlayerStore.getState().addToQueue(b);
    expect(ids()).toEqual([a.id, x.id, b.id, y.id]);
    expect(usePlayerStore.getState().queueIndex).toBe(1);
  });

  it('are appended when no autoplay song follows', () => {
    usePlayerStore.getState().setQueue([a, b], 0);
    usePlayerStore.getState().addToQueue(c);
    expect(ids()).toEqual([a.id, b.id, c.id]);
  });

  it('keep their order when several are added at once, and autoplay still appends', () => {
    playWithAutoplay([a], [x]);

    expect(usePlayerStore.getState().addManyToQueue([b, c], 'manual')).toBe(true);
    expect(ids()).toEqual([a.id, b.id, c.id, x.id]);

    const { currentSong, playbackSequence } = usePlayerStore.getState();
    usePlayerStore.getState().addManyToQueue([y], 'auto', { currentSongId: currentSong!.id, playbackSequence });
    expect(ids()).toEqual([a.id, b.id, c.id, x.id, y.id]);
  });
});

describe('closing the player with 元に戻す', () => {
  const second = { ...song, id: song.id + 30, name: 'Close fixture 2' };
  const third = { ...song, id: song.id + 31, name: 'Close fixture 3' };
  const other = { ...song, id: song.id + 40, name: 'Started after the close' };

  afterEach(async () => {
    usePlayerStore.getState().closePlayer();
    const { clearToasts } = await import('./toastStore');
    clearToasts();
  });

  async function closeWithUndo() {
    const { closePlayerWithUndo } = await import('../components/watch/watchActions');
    const { useToastStore } = await import('./toastStore');
    closePlayerWithUndo(source => source);
    const toast = useToastStore.getState().toasts[0];
    expect(toast?.message).toBe('プレイヤーを閉じました');
    expect(toast?.action?.label).toBe('元に戻す');
    return toast!.action!.onAction;
  }

  it('brings back the queue, its position, title and mix seed', async () => {
    const { useProgressStore } = await import('./progressStore');
    usePlayerStore.getState().setQueue([song, second, third], 0, true, 'manual', 'テストプレイリスト');
    usePlayerStore.getState().next();
    useProgressStore.getState().setProgress(42);

    const undo = await closeWithUndo();
    expect(usePlayerStore.getState().currentSong).toBeNull();
    expect(usePlayerStore.getState().queue).toEqual([]);
    // Nothing is written back until 元に戻す is pressed.
    expect(localStorage.getItem('diva_playerQueue')).toBeNull();

    undo();
    const state = usePlayerStore.getState();
    expect(state.queue.map(item => item.id)).toEqual([song.id, second.id, third.id]);
    expect(state.queueIndex).toBe(1);
    expect(state.currentSong?.id).toBe(second.id);
    expect(state.queueTitle).toBe('テストプレイリスト');
    expect(state.rootSeed?.id).toBe(song.id);
    expect(state.isPlaying).toBe(true);
    expect(state.seekTarget).toBe(42);
    const stored = JSON.parse(localStorage.getItem('diva_playerQueue') ?? '{}') as {
      songIds?: number[];
      queueIndex?: number;
      queueTitle?: string;
      rootSeedId?: number;
    };
    expect(stored.songIds).toEqual([song.id, second.id, third.id]);
    expect(stored.queueIndex).toBe(1);
    expect(stored.queueTitle).toBe('テストプレイリスト');
    expect(stored.rootSeedId).toBe(song.id);
  });

  it('does nothing once another song was started', async () => {
    usePlayerStore.getState().setQueue([song, second], 0);
    const undo = await closeWithUndo();

    usePlayerStore.getState().setQueue([other], 0);
    undo();
    const state = usePlayerStore.getState();
    expect(state.currentSong?.id).toBe(other.id);
    expect(state.queue.map(item => item.id)).toEqual([other.id]);
  });

  it('keeps songs queued after the close (SelectionFAB adds without starting them)', async () => {
    usePlayerStore.getState().setQueue([song, second], 0);
    const undo = await closeWithUndo();

    usePlayerStore.getState().addManyToQueue([other], 'manual');
    undo();
    const state = usePlayerStore.getState();
    expect(state.currentSong).toBeNull();
    expect(state.queue.map(item => item.id)).toEqual([other.id]);
  });

  it('resumes the closed playback itself (same sequence and PV), not a new one', async () => {
    usePlayerStore.getState().setQueue([song, second], 0, true, 'auto');
    const { playbackSequence, currentPV } = usePlayerStore.getState();
    const undo = await closeWithUndo();
    expect(usePlayerStore.getState().undoableCloseSequence).toBe(playbackSequence);

    undo();
    const state = usePlayerStore.getState();
    expect(state.playbackSequence).toBe(playbackSequence);
    expect(state.currentPV).toEqual(currentPV);
    expect(state.currentPlaybackSource).toBe('auto');
    expect(state.queueSources).toEqual(['auto', 'auto']);
    expect(state.undoableCloseSequence).toBeNull();
  });

  it('offers the undo window only while its toast is up', async () => {
    const { clearToasts } = await import('./toastStore');
    usePlayerStore.getState().setQueue([song, second], 0);
    await closeWithUndo();
    expect(usePlayerStore.getState().undoableCloseSequence).not.toBeNull();

    clearToasts();
    await Promise.resolve();
    expect(usePlayerStore.getState().undoableCloseSequence).toBeNull();
  });

  it('goes on with the play when the toast is removed just before 元に戻す runs (as ToastHost does)', async () => {
    const { dismissToast, useToastStore } = await import('./toastStore');
    usePlayerStore.getState().setQueue([song, second], 0);
    const { playbackSequence } = usePlayerStore.getState();
    const undo = await closeWithUndo();

    dismissToast(useToastStore.getState().toasts[0]!.id);
    undo();
    await Promise.resolve();
    expect(usePlayerStore.getState().currentSong?.id).toBe(song.id);
    expect(usePlayerStore.getState().playbackSequence).toBe(playbackSequence);
    expect(usePlayerStore.getState().undoableCloseSequence).toBeNull();
  });

  it('brings back a close that was already counted as a new play', async () => {
    usePlayerStore.getState().setQueue([song, second], 0);
    const { playbackSequence } = usePlayerStore.getState();
    const undo = await closeWithUndo();

    // What PlayerTracker's pagehide does with a close still waiting for its 元に戻す.
    usePlayerStore.setState({ undoableCloseSequence: null });
    undo();
    expect(usePlayerStore.getState().currentSong?.id).toBe(song.id);
    expect(usePlayerStore.getState().playbackSequence).toBe(playbackSequence + 1);
  });

  it('marks a close without undo as such', () => {
    usePlayerStore.getState().setQueue([song, second], 0);
    usePlayerStore.getState().closePlayer();
    expect(usePlayerStore.getState().undoableCloseSequence).toBeNull();
  });

  it('cannot resume once another song has played and been closed', async () => {
    usePlayerStore.getState().setQueue([song, second], 0);
    const undo = await closeWithUndo();

    usePlayerStore.getState().setQueue([other], 0);
    usePlayerStore.getState().closePlayer();
    undo();
    expect(usePlayerStore.getState().currentSong).toBeNull();
    expect(usePlayerStore.getState().queue).toEqual([]);
  });

  it('does not carry a paused undo\'s pending seek over to the next song', async () => {
    const { useProgressStore } = await import('./progressStore');
    usePlayerStore.getState().setQueue([song, second], 0, false);
    useProgressStore.getState().setProgress(133);
    const undo = await closeWithUndo();

    undo();
    expect(usePlayerStore.getState().isPlaying).toBe(false);
    expect(usePlayerStore.getState().seekTarget).toBe(133);
    usePlayerStore.getState().next();
    expect(usePlayerStore.getState().currentSong?.id).toBe(second.id);
    expect(usePlayerStore.getState().seekTarget).toBeNull();
  });
});

describe('pending seeks', () => {
  const second = { ...song, id: song.id + 50, name: 'Seek fixture 2' };

  afterEach(() => {
    usePlayerStore.setState({ loopMode: 'none' });
    usePlayerStore.getState().closePlayer();
  });

  it('belong to the playback they were asked for', () => {
    usePlayerStore.getState().setQueue([song, second], 0, false);
    usePlayerStore.getState().seekTo(90);
    usePlayerStore.getState().next();
    expect(usePlayerStore.getState().seekTarget).toBeNull();

    // Replaying the same song is a new playback too.
    usePlayerStore.getState().seekTo(60);
    usePlayerStore.getState().jumpToIndex(1);
    expect(usePlayerStore.getState().seekTarget).toBeNull();
  });

  it('are dropped when the player closes', () => {
    usePlayerStore.getState().setQueue([song, second], 0, false);
    usePlayerStore.getState().seekTo(90);
    usePlayerStore.getState().closePlayer();
    expect(usePlayerStore.getState().seekTarget).toBeNull();
  });

  it('still take a seek asked for right after the song starts', () => {
    usePlayerStore.getState().setQueue([song, second], 0);
    usePlayerStore.getState().seekTo(45);
    expect(usePlayerStore.getState().seekTarget).toBe(45);
  });

  it('keep the 1曲ループ restart from the top', () => {
    usePlayerStore.getState().setQueue([song, second], 0);
    usePlayerStore.setState({ loopMode: 'one' });
    const { playbackSequence } = usePlayerStore.getState();
    usePlayerStore.getState().next();
    expect(usePlayerStore.getState().currentSong?.id).toBe(song.id);
    expect(usePlayerStore.getState().playbackSequence).toBe(playbackSequence + 1);
    expect(usePlayerStore.getState().seekTarget).toBe(0);
  });
});

describe('player volume persistence', () => {
  it('defaults to 50% and persists volume changes for every player service', () => {
    expect(DEFAULT_VOLUME).toBe(50);
    expect(usePlayerStore.getState().volume).toBe(50);

    usePlayerStore.getState().setVolume(37);

    expect(localStorageValues.get('diva_volume')).toBe('37');
    expect(usePlayerStore.getState().volume).toBe(37);
    usePlayerStore.getState().setVolume(DEFAULT_VOLUME);
  });
});
