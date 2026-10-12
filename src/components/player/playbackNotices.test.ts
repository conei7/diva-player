import { describe, expect, it } from 'vitest';
import type { PV, PVService } from '../../types/vocadb';
import {
  createPlaybackFailureTracker,
  PLAYBACK_FAILURE_SETTLE_MS,
  type PlaybackFailureSnapshot,
  type PlaybackNotice,
} from './playbackNotices';

function pv(id: number, service: PVService): PV {
  return { author: '', disabled: false, id, length: 200, name: 'pv', pvId: `pv-${id}`, service, pvType: 'Original', url: '' };
}

const youtube = pv(11, 'Youtube');
const nico = pv(12, 'NicoNicoDouga');
const songA = { id: 1, pvs: [youtube, nico] };
const songB = { id: 2, pvs: [pv(21, 'Youtube')] };
const noVideoSong = { id: 3, pvs: [] };

function setup() {
  const notices: PlaybackNotice[] = [];
  const settled: string[] = [];
  const timers: Array<{ callback: () => void; ms: number; cleared: boolean }> = [];
  const tracker = createPlaybackFailureTracker({
    onNotice: notice => notices.push(notice),
    onSettled: error => settled.push(error),
    setTimer: (callback, ms) => {
      const timer = { callback, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: handle => { (handle as { cleared: boolean }).cleared = true; },
  });
  let state: PlaybackFailureSnapshot = {
    currentSong: songA,
    currentPV: youtube,
    queue: [songA, songB],
    queueIndex: 0,
    error: null,
  };
  const set = (patch: Partial<PlaybackFailureSnapshot>) => {
    const prev = state;
    state = { ...state, ...patch };
    tracker.update(state, prev);
  };
  const runTimers = () => {
    for (const timer of timers.splice(0)) if (!timer.cleared) timer.callback();
  };
  return { notices, settled, timers, set, runTimers, getState: () => state };
}

describe('createPlaybackFailureTracker', () => {
  it('reports a switch to another video of the same song', () => {
    const { notices, set, runTimers } = setup();
    set({ error: 'YouTube failed' });
    set({ currentPV: nico, error: null });
    runTimers();
    expect(notices).toEqual([{ kind: 'switched', from: 'Youtube', to: 'NicoNicoDouga' }]);
  });

  it('reports a skip to the next song with the failed queue position', () => {
    const { notices, set, runTimers } = setup();
    set({ error: 'every video failed' });
    set({ queueIndex: 1 });
    set({ currentSong: songB, currentPV: songB.pvs[0], error: null });
    runTimers();
    expect(notices).toEqual([{ kind: 'skipped', songId: 1, queueIndex: 0, canGoBack: true }]);
  });

  it('reports a failure when nothing else can play, then lets the caller clear the error', () => {
    const { notices, settled, timers, set, runTimers } = setup();
    set({ queue: [songA], error: 'every video failed' });
    expect(notices).toEqual([]);
    expect(timers[0]?.ms).toBe(PLAYBACK_FAILURE_SETTLE_MS);
    runTimers();
    expect(notices).toEqual([{ kind: 'failed', songId: 1, canRetry: true }]);
    expect(settled).toEqual(['every video failed']);
  });

  it('skips a queued song without any video without offering to go back', () => {
    const { notices, set, runTimers } = setup();
    set({ queue: [songA, noVideoSong, songB] });
    set({ queueIndex: 1 });
    set({ error: 'no playable video' });
    // The store skips it 500ms later.
    set({ queueIndex: 2 });
    set({ currentSong: songB, currentPV: songB.pvs[0], error: null });
    runTimers();
    expect(notices).toEqual([{ kind: 'skipped', songId: 3, queueIndex: 1, canGoBack: false }]);
  });

  it('does not offer a retry for a song without any video', () => {
    const { notices, set, runTimers } = setup();
    set({ queue: [noVideoSong], queueIndex: 0, currentSong: null, currentPV: null });
    set({ error: 'no playable video' });
    runTimers();
    expect(notices).toEqual([{ kind: 'failed', songId: 3, canRetry: false }]);
  });

  it('ignores manual video changes and song changes that follow no error', () => {
    const { notices, set, runTimers } = setup();
    set({ currentPV: nico });
    set({ currentSong: songB, currentPV: songB.pvs[0], queueIndex: 1 });
    runTimers();
    expect(notices).toEqual([]);
  });

  it('reports the same error again once the previous one was cleared', () => {
    const { notices, set, runTimers, getState } = setup();
    set({ queue: [songA], error: 'timeout' });
    runTimers();
    expect(getState().error).toBe('timeout');
    set({ error: null });
    set({ error: 'timeout' });
    runTimers();
    expect(notices.map(notice => notice.kind)).toEqual(['failed', 'failed']);
  });
});
