export type NicoPlayerEvent =
  | { type: 'ready'; duration?: number }
  | { type: 'progress'; seconds: number }
  | { type: 'playing' }
  | { type: 'paused' }
  | { type: 'ended' };

export function normalizeNicoVolume(volume: number): number {
  if (!Number.isFinite(volume)) return 0;
  return Math.max(0, Math.min(1, volume / 100));
}

export function createNicoVolumeMessage(volume: number): string {
  return JSON.stringify({
    eventName: 'player:volume',
    data: { volume: normalizeNicoVolume(volume) },
  });
}

export function parseNicoPlayerMessage(data: unknown): NicoPlayerEvent | null {
  let message: { eventName?: string; data?: Record<string, unknown> };
  try {
    message = typeof data === 'string' ? JSON.parse(data) : data as typeof message;
  } catch {
    return null;
  }
  if (!message || typeof message.eventName !== 'string') return null;

  switch (message.eventName) {
    case 'player:loadComplete':
    case 'loadComplete': {
      const info = message.data?.videoInfo as { lengthInSeconds?: unknown } | undefined;
      const duration = typeof info?.lengthInSeconds === 'number' && info.lengthInSeconds > 0
        ? info.lengthInSeconds
        : undefined;
      return { type: 'ready', duration };
    }
    case 'player:currentTime': {
      const seconds = (message.data as { currentTime?: unknown } | undefined)?.currentTime;
      return typeof seconds === 'number' && Number.isFinite(seconds) ? { type: 'progress', seconds } : null;
    }
    case 'seekStatusChange': {
      const milliseconds = (message.data as { currentTime?: unknown } | undefined)?.currentTime;
      return typeof milliseconds === 'number' && Number.isFinite(milliseconds)
        ? { type: 'progress', seconds: milliseconds / 1000 }
        : null;
    }
    case 'player:play':
      return { type: 'playing' };
    case 'player:pause':
      return { type: 'paused' };
    case 'player:ended':
      return { type: 'ended' };
    case 'playerStatusChange': {
      const status = (message.data as { playerStatus?: unknown } | undefined)?.playerStatus;
      if (status === 3) return { type: 'playing' };
      if (status === 4) return { type: 'paused' };
      if (status === 5) return { type: 'ended' };
      return null;
    }
    default:
      return null;
  }
}

export function normalizeNicoProgress(seconds: number, duration?: number): number {
  if (!Number.isFinite(seconds)) return 0;
  const lowerBound = Math.max(0, seconds);
  return duration && duration > 0 ? Math.min(duration, lowerBound) : lowerBound;
}

export function createNicoProgressTracker(now: () => number = () => Date.now()) {
  let confirmedSeconds = 0;
  let confirmedAt: number | null = null;
  let playing = false;
  let duration: number | undefined;

  const current = () => normalizeNicoProgress(
    playing && confirmedAt !== null ? confirmedSeconds + (now() - confirmedAt) / 1000 : confirmedSeconds,
    duration,
  );

  return {
    setDuration(nextDuration?: number) {
      duration = nextDuration && nextDuration > 0 ? nextDuration : undefined;
      confirmedSeconds = normalizeNicoProgress(confirmedSeconds, duration);
    },
    confirm(seconds: number) {
      confirmedSeconds = normalizeNicoProgress(seconds, duration);
      confirmedAt = playing ? now() : null;
    },
    setPlaying(nextPlaying: boolean) {
      if (playing === nextPlaying) return;
      if (!nextPlaying) confirmedSeconds = current();
      playing = nextPlaying;
      confirmedAt = playing ? now() : null;
    },
    current,
    reset() {
      confirmedSeconds = 0;
      confirmedAt = playing ? now() : null;
    },
  };
}
