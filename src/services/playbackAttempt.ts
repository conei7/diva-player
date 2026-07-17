export const DEFAULT_PLAYBACK_READY_TIMEOUT_MS = 12_000;

export interface PlaybackAttemptToken {
  generation: number;
  pvId: string;
}

/** Coordinates one player generation and ignores late callbacks from older generations. */
export function createPlaybackAttemptController(timeoutMs = DEFAULT_PLAYBACK_READY_TIMEOUT_MS) {
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const clearTimer = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  return {
    start(pvId: string, onTimeout: () => void): PlaybackAttemptToken {
      clearTimer();
      const token = { generation: generation + 1, pvId };
      generation = token.generation;
      timer = setTimeout(() => {
        timer = null;
        if (generation === token.generation) onTimeout();
      }, timeoutMs);
      return token;
    },
    isCurrent(token: PlaybackAttemptToken): boolean {
      return generation === token.generation;
    },
    complete(token: PlaybackAttemptToken): void {
      if (!this.isCurrent(token)) return;
      clearTimer();
    },
    cancel(): void {
      generation += 1;
      clearTimer();
    },
  };
}
