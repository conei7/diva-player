import { describe, expect, it } from 'vitest';
import {
  buildNicoEmbedUrl,
  createNicoPlaybackMessage,
  createNicoProgressTracker,
  createNicoVolumeMessage,
  normalizeNicoProgress,
  normalizeNicoVolume,
  parseNicoPlayerMessage,
} from './nicoPlayerSync';

describe('nico player synchronization', () => {
  it('enables the iframe control API and preserves autoplay intent', () => {
    const url = new URL(buildNicoEmbedUrl('sm7918983', true, 'diva-player-1'));
    expect(url.origin).toBe('https://embed.nicovideo.jp');
    expect(url.pathname).toBe('/watch/sm7918983');
    expect(url.searchParams.get('jsapi')).toBe('1');
    expect(url.searchParams.get('autoplay')).toBe('1');
    expect(url.searchParams.get('playerId')).toBe('diva-player-1');
  });

  it('parses current time in seconds and legacy milliseconds', () => {
    expect(parseNicoPlayerMessage(JSON.stringify({ eventName: 'player:currentTime', data: { currentTime: 12.5 } }))).toEqual({ type: 'progress', seconds: 12.5 });
    expect(parseNicoPlayerMessage({ eventName: 'seekStatusChange', data: { currentTime: 12500 } })).toEqual({ type: 'progress', seconds: 12.5 });
  });

  it('maps status and ignores malformed messages', () => {
    expect(parseNicoPlayerMessage({ eventName: 'playerStatusChange', data: { playerStatus: 3 } })).toEqual({ type: 'playing' });
    expect(parseNicoPlayerMessage({ eventName: 'playerStatusChange', data: { playerStatus: 5 } })).toEqual({ type: 'ended' });
    expect(parseNicoPlayerMessage('{bad')).toBeNull();
  });

  it('keeps a single progress clock without double counting pause', () => {
    let time = 1_000;
    const tracker = createNicoProgressTracker(() => time);
    tracker.confirm(10);
    tracker.setPlaying(true);
    time += 2_000;
    expect(tracker.current()).toBe(12);
    tracker.setPlaying(false);
    expect(tracker.current()).toBe(12);
    time += 2_000;
    expect(tracker.current()).toBe(12);
  });

  it('clamps progress to valid bounds', () => {
    expect(normalizeNicoProgress(-1, 120)).toBe(0);
    expect(normalizeNicoProgress(200, 120)).toBe(120);
  });

  it('normalizes and serializes volume for the Nico iframe API', () => {
    expect(normalizeNicoVolume(35)).toBeCloseTo(0.35);
    expect(normalizeNicoVolume(-10)).toBe(0);
    expect(normalizeNicoVolume(150)).toBe(1);
    expect(createNicoVolumeMessage('diva-player-1', 35)).toEqual({
      sourceConnectorType: 1,
      playerId: 'diva-player-1',
      eventName: 'volumeChange',
      data: { volume: 0.35 },
    });
  });

  it('uses the current Nico connector protocol for playback commands', () => {
    expect(createNicoPlaybackMessage('diva-player-1', true)).toEqual({
      sourceConnectorType: 1,
      playerId: 'diva-player-1',
      eventName: 'play',
      data: {},
    });
    expect(createNicoPlaybackMessage('diva-player-1', false)).toEqual({
      sourceConnectorType: 1,
      playerId: 'diva-player-1',
      eventName: 'pause',
      data: {},
    });
  });
});
