import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

let usePlayerStore: typeof import('../../stores/playerStore').usePlayerStore;
let DEFAULT_VOLUME: number;
let mute: typeof import('./playerMute');
const localStorageValues = new Map<string, string>();

beforeAll(async () => {
  vi.stubGlobal('localStorage', {
    get length() { return localStorageValues.size; },
    getItem: (key: string) => localStorageValues.get(key) ?? null,
    setItem: (key: string, value: string) => { localStorageValues.set(key, value); },
    removeItem: (key: string) => { localStorageValues.delete(key); },
    key: (index: number) => [...localStorageValues.keys()][index] ?? null,
  });
  ({ usePlayerStore, DEFAULT_VOLUME } = await import('../../stores/playerStore'));
  mute = await import('./playerMute');
});

beforeEach(() => {
  usePlayerStore.getState().setVolume(40);
  mute.usePlayerMuteStore.setState({ muted: false, volumeBeforeMute: DEFAULT_VOLUME, changedAt: Number.NEGATIVE_INFINITY });
});

const savedVolume = () => localStorageValues.get('diva_volume');

describe('toggleMute', () => {
  it('mutes in memory only and keeps the saved volume', () => {
    expect(mute.toggleMute(1_000)).toBe(true);
    expect(usePlayerStore.getState().volume).toBe(0);
    expect(savedVolume()).toBe('40');
    expect(mute.usePlayerMuteStore.getState()).toMatchObject({ muted: true, volumeBeforeMute: 40 });
  });

  it('unmutes back to the volume from before', () => {
    mute.toggleMute(1_000);
    expect(mute.toggleMute(2_000)).toBe(false);
    expect(usePlayerStore.getState().volume).toBe(40);
    expect(savedVolume()).toBe('40');
    expect(mute.usePlayerMuteStore.getState().muted).toBe(false);
  });

  it('turns a saved volume of 0 back up to the default', () => {
    usePlayerStore.getState().setVolume(0);
    expect(mute.toggleMute(1_000)).toBe(false);
    expect(usePlayerStore.getState().volume).toBe(DEFAULT_VOLUME);
    expect(savedVolume()).toBe(String(DEFAULT_VOLUME));
  });
});

describe('unmutePlayer', () => {
  it('leaves an audible volume alone when nothing was muted', () => {
    mute.unmutePlayer(1_000);
    expect(usePlayerStore.getState().volume).toBe(40);
  });
});

describe('isVolumeHeldByMute', () => {
  it('holds reports while muted and for a moment after unmuting', () => {
    expect(mute.isVolumeHeldByMute(0)).toBe(false);
    mute.mutePlayer(10_000);
    expect(mute.isVolumeHeldByMute(10_000 + 60_000)).toBe(true);
    mute.unmutePlayer(80_000);
    expect(mute.isVolumeHeldByMute(80_000 + mute.MUTE_REPORT_SETTLE_MS - 1)).toBe(true);
    expect(mute.isVolumeHeldByMute(80_000 + mute.MUTE_REPORT_SETTLE_MS)).toBe(false);
  });
});

describe('isSilentVolume', () => {
  it('is true only for 0 or less', () => {
    expect(mute.isSilentVolume(0)).toBe(true);
    expect(mute.isSilentVolume(-1)).toBe(true);
    expect(mute.isSilentVolume(1)).toBe(false);
  });
});
