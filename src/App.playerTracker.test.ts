/**
 * PlayerTracker (App.tsx) around プレイヤーを閉じる and its 元に戻す: the closed play counts only
 * when the close is not undone, and an undone close goes on as the same play.
 *
 * No DOM here, so the component runs in a minimal one-component hook runner: refs by call order,
 * effects in order after each render when their deps changed, store hooks reading the state.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import type { Song } from './types/vocadb';

const runner = vi.hoisted(() => {
  let slots: unknown[] = [];
  let index = 0;
  let effects: Array<() => void> = [];
  return {
    reset: () => { slots = []; },
    useRef: <T,>(initial: T) => {
      const i = index++;
      if (!(i in slots)) slots[i] = { current: initial };
      return slots[i] as { current: T };
    },
    useEffect: (effect: () => void, deps?: unknown[]) => {
      const i = index++;
      const previous = slots[i] as unknown[] | undefined;
      if (previous && deps && deps.every((dep, k) => Object.is(dep, previous[k]))) return;
      slots[i] = deps;
      effects.push(effect);
    },
    render: (component: () => unknown) => {
      index = 0;
      effects = [];
      component();
      effects.forEach(effect => effect());
    },
    /** A zustand hook usable outside React: same store, selector over the current state. */
    readingHook: <H extends { getState: () => unknown }>(hook: H): H => Object.assign(
      (selector: (state: unknown) => unknown) => selector(hook.getState()),
      hook,
    ),
  };
});

vi.mock('react', async importOriginal => ({
  ...await importOriginal<typeof import('react')>(),
  useRef: runner.useRef,
  useEffect: runner.useEffect,
}));
vi.mock('./stores/playerStore', async importOriginal => {
  const actual = await importOriginal<typeof import('./stores/playerStore')>();
  return { ...actual, usePlayerStore: runner.readingHook(actual.usePlayerStore) };
});
vi.mock('./stores/progressStore', async importOriginal => {
  const actual = await importOriginal<typeof import('./stores/progressStore')>();
  return { ...actual, useProgressStore: runner.readingHook(actual.useProgressStore) };
});
vi.mock('./stores/historyStore', async importOriginal => {
  const actual = await importOriginal<typeof import('./stores/historyStore')>();
  return { ...actual, useHistoryStore: runner.readingHook(actual.useHistoryStore) };
});
// Play events stay pending: the store's own state is what these tests read.
vi.mock('./services/historyDatabase', async importOriginal => ({
  ...await importOriginal<typeof import('./services/historyDatabase')>(),
  openHistoryDb: () => new Promise(() => {}),
}));
// The rest of the app is not rendered.
vi.mock('./components/layout/Layout', () => ({ default: () => null }));
vi.mock('./components/player/KeyboardShortcuts', () => ({ default: () => null }));
vi.mock('./components/player/GlobalPlayer', () => ({ default: () => null }));
vi.mock('./components/AppErrorBoundary', () => ({ default: () => null }));
vi.mock('./components/layout/NotFoundPage', () => ({ default: () => null }));
vi.mock('./components/layout/RouteErrorBoundary', () => ({ DeferredBoundary: () => null }));
vi.mock('./components/ui/ToastHost', () => ({ default: () => null }));
vi.mock('./components/ui/ConfirmHost', () => ({ default: () => null }));
vi.mock('./routes/routeLoaders', () => ({ loadRoute: () => new Promise(() => {}) }));

const localStorageValues = new Map<string, string>();

function makeSong(id: number): Song {
  return {
    id,
    name: `Tracker fixture ${id}`,
    artistString: 'Fixture producer',
    defaultName: `Tracker fixture ${id}`,
    lengthSeconds: 200,
    pvs: [{
      author: '', disabled: false, id: id * 10, length: 200, name: 'fixture',
      pvId: `fixture-${id}`, service: 'Youtube', pvType: 'Original', url: `https://youtu.be/fixture-${id}`,
    }],
  } as unknown as Song;
}

const closed = makeSong(940001);
const following = makeSong(940002);

let stores: {
  player: typeof import('./stores/playerStore').usePlayerStore;
  progress: typeof import('./stores/progressStore').useProgressStore;
  history: typeof import('./stores/historyStore').useHistoryStore;
  feedback: typeof import('./stores/implicitFeedbackStore').useImplicitFeedbackStore;
  bandit: typeof import('./stores/autoQueueBanditStore').useAutoQueueBanditStore;
  toast: typeof import('./stores/toastStore');
};
let PlayerTracker: typeof import('./App').PlayerTracker;
let finalizeHistoryEntry: MockInstance;
let recordBanditOutcome: MockInstance;
const render = () => runner.render(PlayerTracker);

beforeAll(async () => {
  vi.stubGlobal('localStorage', {
    get length() { return localStorageValues.size; },
    getItem: (key: string) => localStorageValues.get(key) ?? null,
    setItem: (key: string, value: string) => { localStorageValues.set(key, value); },
    removeItem: (key: string) => { localStorageValues.delete(key); },
    key: (index: number) => [...localStorageValues.keys()][index] ?? null,
  });
  ({ PlayerTracker } = await import('./App'));
  const { useAutoQueueDecisionStore } = await import('./stores/autoQueueDecisionStore');
  stores = {
    player: (await import('./stores/playerStore')).usePlayerStore,
    progress: (await import('./stores/progressStore')).useProgressStore,
    history: (await import('./stores/historyStore')).useHistoryStore,
    feedback: (await import('./stores/implicitFeedbackStore')).useImplicitFeedbackStore,
    bandit: (await import('./stores/autoQueueBanditStore')).useAutoQueueBanditStore,
    toast: await import('./stores/toastStore'),
  };
  useAutoQueueDecisionStore.getState().recordDecisions([
    { songId: closed.id, strategyArm: 'balanced', generatedAt: 1 } as never,
  ]);
});

beforeEach(() => {
  // Each test is a fresh PlayerTracker over an empty player and history.
  stores.player.getState().closePlayer();
  stores.history.setState({
    entries: [], totalPlays: 0,
    activePlayEventId: undefined, activeSongId: undefined, activePlayedAt: undefined, activePlaybackSequence: undefined,
  });
  stores.feedback.getState().clearFeedback();
  finalizeHistoryEntry = vi.spyOn(stores.history.getState(), 'finalizeHistoryEntry');
  recordBanditOutcome = vi.spyOn(stores.bandit.getState(), 'recordOutcome');
  // The new instance's pagehide listener goes here.
  vi.stubGlobal('window', new EventTarget());
  runner.reset();
  render();
});

afterEach(() => {
  stores.toast.clearToasts();
  vi.restoreAllMocks();
});

/** The closed song plays as an autoplay song at 0:20 of 3:20. */
function playClosedSongFor20Seconds(): number {
  stores.player.getState().setQueue([closed, following], 0, true, 'auto');
  render();
  stores.progress.getState().setDuration(200);
  stores.progress.getState().setProgress(20);
  render();
  return stores.player.getState().playbackSequence;
}

async function closeWithUndo(): Promise<() => void> {
  const { closePlayerWithUndo } = await import('./components/watch/watchActions');
  closePlayerWithUndo(source => source);
  render();
  const toast = stores.toast.useToastStore.getState().toasts[0];
  // As ToastHost does: the toast goes, then its action runs.
  return () => {
    stores.toast.dismissToast(toast.id);
    toast.action!.onAction();
    render();
  };
}

const skips = () => stores.feedback.getState().getFeedback(closed.id)?.skipCount ?? 0;

describe('PlayerTracker and プレイヤーを閉じる with 元に戻す', () => {
  it('holds back the closed play while 元に戻す is offered', async () => {
    const sequence = playClosedSongFor20Seconds();
    expect(stores.history.getState().totalPlays).toBe(1);

    await closeWithUndo();
    expect(stores.player.getState().undoableCloseSequence).toBe(sequence);
    expect(skips()).toBe(0);
    expect(finalizeHistoryEntry).not.toHaveBeenCalled();
    expect(recordBanditOutcome).not.toHaveBeenCalled();
  });

  it('continues the same play after 元に戻す: no second play, no skip, finalized once at its end', async () => {
    const sequence = playClosedSongFor20Seconds();
    const undo = await closeWithUndo();
    undo();

    expect(stores.player.getState().currentSong?.id).toBe(closed.id);
    expect(stores.player.getState().playbackSequence).toBe(sequence);
    expect(stores.history.getState().totalPlays).toBe(1);
    expect(stores.history.getState().entries.map(entry => entry.song.id)).toEqual([closed.id]);
    expect(skips()).toBe(0);
    expect(finalizeHistoryEntry).not.toHaveBeenCalled();

    stores.progress.getState().setProgress(190);
    render();
    stores.player.getState().next();
    render();
    expect(finalizeHistoryEntry).toHaveBeenCalledTimes(1);
    expect(finalizeHistoryEntry).toHaveBeenCalledWith(closed.id, 190, 200, sequence);
    expect(stores.feedback.getState().getFeedback(closed.id)).toMatchObject({ skipCount: 0, completeCount: 1 });
    expect(recordBanditOutcome.mock.calls).toEqual([['balanced', 'complete']]);
    expect(stores.history.getState().totalPlays).toBe(2);
  });

  it('counts a close that is not undone once its toast goes', async () => {
    const sequence = playClosedSongFor20Seconds();
    await closeWithUndo();

    stores.toast.clearToasts();
    await Promise.resolve();
    expect(stores.player.getState().undoableCloseSequence).toBeNull();
    render();
    expect(finalizeHistoryEntry).toHaveBeenCalledWith(closed.id, 20, 200, sequence);
    expect(skips()).toBe(1);
    expect(recordBanditOutcome.mock.calls).toEqual([['balanced', 'skip']]);
  });

  it('counts the closed play when another song starts during the undo window', async () => {
    const sequence = playClosedSongFor20Seconds();
    await closeWithUndo();

    stores.player.getState().setQueue([following], 0);
    render();
    expect(finalizeHistoryEntry).toHaveBeenCalledWith(closed.id, 20, 200, sequence);
    expect(skips()).toBe(1);
    expect(recordBanditOutcome.mock.calls).toEqual([['balanced', 'skip']]);
    // The close ended the closed song's autoplay session: the new song's one starts clean.
    const { useAutoPlaySessionStore } = await import('./stores/autoPlaySessionStore');
    expect(useAutoPlaySessionStore.getState().session).toMatchObject({
      rootSeedId: following.id, autoSkippedCount: 0, consecutiveSkips: 0,
    });
    stores.toast.clearToasts();
    await Promise.resolve();
    render();
    expect(finalizeHistoryEntry).toHaveBeenCalledTimes(1);
    expect(skips()).toBe(1);
  });

  it('counts a pending close on pagehide', async () => {
    playClosedSongFor20Seconds();
    await closeWithUndo();

    window.dispatchEvent(new Event('pagehide'));
    expect(skips()).toBe(1);
    expect(stores.player.getState().undoableCloseSequence).toBeNull();
    stores.toast.clearToasts();
    await Promise.resolve();
    render();
    expect(skips()).toBe(1);
  });

  it('brings a close counted on pagehide back as a new play (an undo after a bfcache return)', async () => {
    const sequence = playClosedSongFor20Seconds();
    const undo = await closeWithUndo();
    window.dispatchEvent(new Event('pagehide'));
    render();
    expect(finalizeHistoryEntry).toHaveBeenCalledTimes(1);

    undo();
    expect(stores.player.getState().currentSong?.id).toBe(closed.id);
    expect(stores.player.getState().playbackSequence).toBe(sequence + 1);
    expect(stores.history.getState().totalPlays).toBe(2);

    // The new play is finalized at its own end, so its listening is not lost.
    stores.progress.getState().setProgress(190);
    render();
    stores.player.getState().next();
    render();
    expect(finalizeHistoryEntry).toHaveBeenCalledTimes(2);
    expect(finalizeHistoryEntry).toHaveBeenLastCalledWith(closed.id, 190, 200, sequence + 1);
    expect(stores.feedback.getState().getFeedback(closed.id)).toMatchObject({ skipCount: 1, completeCount: 1 });
  });

  it('keeps the closed position of a paused undo that is left without 再生', async () => {
    const sequence = playClosedSongFor20Seconds();
    stores.player.getState().pause();
    render();
    const undo = await closeWithUndo();
    undo();
    expect(stores.player.getState().isPlaying).toBe(false);
    expect(stores.player.getState().seekTarget).toBe(20);

    // The YouTube embed cues the video and shows 0:00 until 再生 applies the seek.
    stores.progress.getState().setProgress(0);
    render();
    stores.player.getState().next();
    render();
    expect(finalizeHistoryEntry).toHaveBeenCalledTimes(1);
    expect(finalizeHistoryEntry).toHaveBeenCalledWith(closed.id, 20, 200, sequence);
    expect(skips()).toBe(1);
  });

  it('keeps the undo a continuation after the toast removal settles', async () => {
    const sequence = playClosedSongFor20Seconds();
    const undo = await closeWithUndo();
    undo();
    await Promise.resolve();
    render();

    expect(stores.player.getState().playbackSequence).toBe(sequence);
    expect(stores.player.getState().undoableCloseSequence).toBeNull();
    expect(stores.player.getState().currentSong?.id).toBe(closed.id);
    expect(stores.history.getState().totalPlays).toBe(1);
    expect(finalizeHistoryEntry).not.toHaveBeenCalled();
    expect(skips()).toBe(0);
  });

  it('closes without undo as before: counted at once', () => {
    playClosedSongFor20Seconds();
    stores.player.getState().closePlayer();
    render();
    expect(stores.player.getState().undoableCloseSequence).toBeNull();
    expect(skips()).toBe(1);
  });

  it('adds no play when undoing the close of a song restored from the last session', async () => {
    // The restored session's song: sequence 0, never recorded.
    stores.player.setState({
      queue: [closed, following],
      queueIndex: 0,
      queueSources: ['manual', 'manual'],
      currentSong: closed,
      currentPV: closed.pvs![0],
      playbackSequence: 0,
    });
    render();
    expect(stores.history.getState().totalPlays).toBe(0);

    const undo = await closeWithUndo();
    undo();
    expect(stores.player.getState().currentSong?.id).toBe(closed.id);
    expect(stores.player.getState().playbackSequence).toBe(0);
    expect(stores.history.getState().totalPlays).toBe(0);
  });
});
