export const PLAYBACK_CHANNEL_NAME = 'diva-player-playback-v1';
export const PLAYBACK_OWNER_KEY = 'diva-playback-owner-v1';
const PLAYBACK_TAB_KEY = 'diva-playback-tab-v1';
export const PLAYBACK_OWNER_HEARTBEAT_MS = 3_000;
export const PLAYBACK_OWNER_STALE_MS = 10_000;

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

export function shouldAcceptPlayerPlayingEvent(options: {
  requestedPlaying: boolean;
  ownershipState: PlaybackOwnershipState;
  programmaticPausePending: boolean;
  nativePlayerFocused: boolean;
}): boolean {
  if (options.requestedPlaying || options.nativePlayerFocused) return true;
  return !options.programmaticPausePending && options.ownershipState !== 'remote';
}

export function createPlaybackOwnership(options: PlaybackOwnershipOptions = {}) {
  const tabId = options.tabId ?? getDefaultTabId();
  const now = options.now ?? (() => Date.now());
  const channel = options.channel ?? getDefaultChannel();
  const storage = options.storage ?? getDefaultStorage();
  let onRemoteClaim: (() => void) | null = null;
  const initial = readInitialOwnership(storage, tabId, now());
  let state = initial.state;
  let remoteClaimedAt = initial.remoteClaimedAt;
  let remoteExpiryTimer: ReturnType<typeof setTimeout> | null = null;
  const subscribers = new Set<() => void>();

  const setState = (nextState: PlaybackOwnershipState) => {
    if (state === nextState) return;
    state = nextState;
    for (const subscriber of subscribers) subscriber();
  };

  const clearRemoteExpiry = () => {
    if (remoteExpiryTimer === null) return;
    clearTimeout(remoteExpiryTimer);
    remoteExpiryTimer = null;
  };

  const scheduleRemoteExpiry = (claimedAt: number) => {
    clearRemoteExpiry();
    const remaining = Math.max(0, PLAYBACK_OWNER_STALE_MS - (now() - claimedAt));
    remoteExpiryTimer = setTimeout(() => {
      remoteExpiryTimer = null;
      if (state !== 'remote' || remoteClaimedAt !== claimedAt) return;
      if (now() - claimedAt < PLAYBACK_OWNER_STALE_MS) {
        scheduleRemoteExpiry(claimedAt);
        return;
      }
      remoteClaimedAt = null;
      setState('none');
    }, remaining);
  };

  if (state === 'remote' && remoteClaimedAt !== null) scheduleRemoteExpiry(remoteClaimedAt);

  const applyMessage = (message: PlaybackOwnershipMessage) => {
    if (message.type === 'claim') {
      if (message.tabId === tabId) {
        clearRemoteExpiry();
        remoteClaimedAt = null;
        setState('local');
      } else {
        remoteClaimedAt = message.claimedAt;
        scheduleRemoteExpiry(message.claimedAt);
        setState('remote');
        onRemoteClaim?.();
      }
      return;
    }
    if (message.tabId === tabId || state === 'remote') {
      clearRemoteExpiry();
      remoteClaimedAt = null;
      setState('none');
    }
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
      if (state === 'remote' && (
        remoteClaimedAt === null
        || !Number.isFinite(remoteClaimedAt)
        || now() - remoteClaimedAt >= PLAYBACK_OWNER_STALE_MS
      )) {
        clearRemoteExpiry();
        remoteClaimedAt = null;
        state = 'none';
      }
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
      clearRemoteExpiry();
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

function readInitialOwnership(
  storage: StorageLike | null,
  tabId: string,
  currentTime: number,
): { state: PlaybackOwnershipState; remoteClaimedAt: number | null } {
  if (!storage?.getItem) return { state: 'none', remoteClaimedAt: null };
  try {
    const raw = storage.getItem(PLAYBACK_OWNER_KEY);
    if (!raw) return { state: 'none', remoteClaimedAt: null };
    const message = JSON.parse(raw) as PlaybackOwnershipMessage;
    if (message.type !== 'claim') return { state: 'none', remoteClaimedAt: null };
    if (!Number.isFinite(message.claimedAt) || currentTime - message.claimedAt >= PLAYBACK_OWNER_STALE_MS) {
      return { state: 'none', remoteClaimedAt: null };
    }
    return message.tabId === tabId
      ? { state: 'local', remoteClaimedAt: null }
      : { state: 'remote', remoteClaimedAt: message.claimedAt };
  } catch {
    return { state: 'none', remoteClaimedAt: null };
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
