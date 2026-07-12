export const PLAYBACK_CHANNEL_NAME = 'diva-player-playback-v1';
export const PLAYBACK_OWNER_KEY = 'diva-playback-owner-v1';

export type PlaybackOwnershipMessage =
  | { type: 'claim'; tabId: string; songId: number | null; claimedAt: number }
  | { type: 'release'; tabId: string; releasedAt: number };

type MessageListener = (event: { data: PlaybackOwnershipMessage }) => void;

interface ChannelLike {
  postMessage(message: PlaybackOwnershipMessage): void;
  addEventListener(type: 'message', listener: MessageListener): void;
  removeEventListener(type: 'message', listener: MessageListener): void;
  close?(): void;
}

interface StorageLike {
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface PlaybackOwnershipOptions {
  tabId?: string;
  channel?: ChannelLike | null;
  storage?: StorageLike | null;
  now?: () => number;
}

export function createPlaybackTabId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `tab-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function isRemoteClaim(message: PlaybackOwnershipMessage, tabId: string): boolean {
  return message.type === 'claim' && message.tabId !== tabId;
}

export function createPlaybackOwnership(options: PlaybackOwnershipOptions = {}) {
  const tabId = options.tabId ?? createPlaybackTabId();
  const now = options.now ?? (() => Date.now());
  const channel = options.channel ?? getDefaultChannel();
  const storage = options.storage ?? getDefaultStorage();
  let onRemoteClaim: (() => void) | null = null;

  const handleMessage: MessageListener = (event) => {
    if (isRemoteClaim(event.data, tabId)) onRemoteClaim?.();
  };

  channel?.addEventListener('message', handleMessage);

  const broadcast = (message: PlaybackOwnershipMessage) => {
    channel?.postMessage(message);
    if (storage) {
      try {
        storage.setItem(PLAYBACK_OWNER_KEY, JSON.stringify(message));
      } catch {
        // Storage may be unavailable in private browsing or quota errors.
      }
    }
  };

  const storageListener = (event: StorageEvent) => {
    if (event.key !== PLAYBACK_OWNER_KEY || !event.newValue) return;
    try {
      const message = JSON.parse(event.newValue) as PlaybackOwnershipMessage;
      if (isRemoteClaim(message, tabId)) onRemoteClaim?.();
    } catch {
      // Ignore malformed cross-tab messages.
    }
  };

  if (typeof window !== 'undefined') window.addEventListener('storage', storageListener);

  return {
    tabId,
    claim(songId: number | null) {
      broadcast({ type: 'claim', tabId, songId, claimedAt: now() });
    },
    release() {
      broadcast({ type: 'release', tabId, releasedAt: now() });
    },
    onRemoteClaim(callback: () => void) {
      onRemoteClaim = callback;
      return () => {
        if (onRemoteClaim === callback) onRemoteClaim = null;
      };
    },
    destroy() {
      channel?.removeEventListener('message', handleMessage);
      channel?.close?.();
      if (typeof window !== 'undefined') window.removeEventListener('storage', storageListener);
    },
  };
}

function getDefaultChannel(): ChannelLike | null {
  if (typeof BroadcastChannel === 'undefined') return null;
  return new BroadcastChannel(PLAYBACK_CHANNEL_NAME) as unknown as ChannelLike;
}

function getDefaultStorage(): StorageLike | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
