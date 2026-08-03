export const PLAYBACK_CHANNEL_NAME = 'diva-player-playback-v1';
export const PLAYBACK_OWNER_KEY = 'diva-playback-owner-v1';
const PLAYBACK_TAB_KEY = 'diva-playback-tab-v1';

export type PlaybackOwnershipState = 'none' | 'local' | 'remote';

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
  getItem?(key: string): string | null;
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
  const tabId = options.tabId ?? getDefaultTabId();
  const now = options.now ?? (() => Date.now());
  const channel = options.channel ?? getDefaultChannel();
  const storage = options.storage ?? getDefaultStorage();
  let onRemoteClaim: (() => void) | null = null;
  let state = readInitialState(storage, tabId);
  const subscribers = new Set<() => void>();

  const setState = (nextState: PlaybackOwnershipState) => {
    if (state === nextState) return;
    state = nextState;
    for (const subscriber of subscribers) subscriber();
  };

  const applyMessage = (message: PlaybackOwnershipMessage) => {
    if (message.type === 'claim') {
      if (message.tabId === tabId) {
        setState('local');
      } else {
        setState('remote');
        onRemoteClaim?.();
      }
      return;
    }
    if (message.tabId === tabId || state === 'remote') setState('none');
  };

  const handleMessage: MessageListener = (event) => {
    applyMessage(event.data);
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
      applyMessage(message);
    } catch {
      // Ignore malformed cross-tab messages.
    }
  };

  if (typeof window !== 'undefined') window.addEventListener('storage', storageListener);

  return {
    tabId,
    getState() {
      return state;
    },
    subscribe(callback: () => void) {
      subscribers.add(callback);
      return () => subscribers.delete(callback);
    },
    claim(songId: number | null) {
      const message: PlaybackOwnershipMessage = { type: 'claim', tabId, songId, claimedAt: now() };
      applyMessage(message);
      broadcast(message);
    },
    release() {
      if (state !== 'local') return;
      const message: PlaybackOwnershipMessage = { type: 'release', tabId, releasedAt: now() };
      applyMessage(message);
      broadcast(message);
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
      subscribers.clear();
    },
  };
}

let sharedOwnership: ReturnType<typeof createPlaybackOwnership> | null = null;

export function getPlaybackOwnership() {
  if (!sharedOwnership) sharedOwnership = createPlaybackOwnership();
  return sharedOwnership;
}

function readInitialState(storage: StorageLike | null, tabId: string): PlaybackOwnershipState {
  if (!storage?.getItem) return 'none';
  try {
    const raw = storage.getItem(PLAYBACK_OWNER_KEY);
    if (!raw) return 'none';
    const message = JSON.parse(raw) as PlaybackOwnershipMessage;
    if (message.type !== 'claim') return 'none';
    return message.tabId === tabId ? 'local' : 'remote';
  } catch {
    return 'none';
  }
}

function getDefaultTabId(): string {
  if (typeof window === 'undefined') return createPlaybackTabId();
  try {
    const existing = window.sessionStorage.getItem(PLAYBACK_TAB_KEY);
    if (existing) return existing;
    const created = createPlaybackTabId();
    window.sessionStorage.setItem(PLAYBACK_TAB_KEY, created);
    return created;
  } catch {
    return createPlaybackTabId();
  }
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
