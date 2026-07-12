import { describe, expect, it, vi } from 'vitest';
import { createPlaybackOwnership, isRemoteClaim, type PlaybackOwnershipMessage } from './playbackOwnership';

function fakeChannel() {
  const listeners = new Set<(event: { data: PlaybackOwnershipMessage }) => void>();
  return {
    posted: [] as PlaybackOwnershipMessage[],
    postMessage(message: PlaybackOwnershipMessage) {
      this.posted.push(message);
      for (const listener of listeners) listener({ data: message });
    },
    addEventListener(_type: 'message', listener: (event: { data: PlaybackOwnershipMessage }) => void) {
      listeners.add(listener);
    },
    removeEventListener(_type: 'message', listener: (event: { data: PlaybackOwnershipMessage }) => void) {
      listeners.delete(listener);
    },
    close: vi.fn(),
  };
}

describe('playback ownership', () => {
  it('recognizes only claims from another tab', () => {
    expect(isRemoteClaim({ type: 'claim', tabId: 'a', songId: 1, claimedAt: 1 }, 'b')).toBe(true);
    expect(isRemoteClaim({ type: 'claim', tabId: 'a', songId: 1, claimedAt: 1 }, 'a')).toBe(false);
    expect(isRemoteClaim({ type: 'release', tabId: 'a', releasedAt: 1 }, 'b')).toBe(false);
  });

  it('broadcasts claims and invokes takeover callback for another tab', () => {
    const channel = fakeChannel();
    const owner = createPlaybackOwnership({ tabId: 'owner', channel, storage: null, now: () => 123 });
    const observer = createPlaybackOwnership({ tabId: 'observer', channel, storage: null });
    const takeover = vi.fn();
    observer.onRemoteClaim(takeover);

    owner.claim(42);

    expect(channel.posted[0]).toEqual({ type: 'claim', tabId: 'owner', songId: 42, claimedAt: 123 });
    expect(takeover).toHaveBeenCalledOnce();
    owner.destroy();
    observer.destroy();
  });

  it('stops notifying after destroy', () => {
    const channel = fakeChannel();
    const owner = createPlaybackOwnership({ tabId: 'owner', channel, storage: null });
    const observer = createPlaybackOwnership({ tabId: 'observer', channel, storage: null });
    const takeover = vi.fn();
    observer.onRemoteClaim(takeover);
    observer.destroy();
    owner.claim(1);
    expect(takeover).not.toHaveBeenCalled();
    owner.destroy();
  });
});
