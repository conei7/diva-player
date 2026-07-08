import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface ImplicitSongFeedback {
  skipCount: number;
  completeCount: number;
  removeCount: number;
  lastSkippedAt?: number;
  lastCompletedAt?: number;
  lastRemovedAt?: number;
}

interface ImplicitFeedbackState {
  feedback: Record<string, ImplicitSongFeedback>;
  recordPlayback: (songId: string | number, progress: number, duration: number) => void;
  recordQueueRemove: (songId: string | number) => void;
  getFeedback: (songId: string | number) => ImplicitSongFeedback | undefined;
  clearFeedback: () => void;
}

const MAX_FEEDBACK_ITEMS = 5000;
const MIN_MEANINGFUL_SECONDS = 8;
const SKIP_SECONDS = 30;
const SKIP_RATE = 0.2;
const COMPLETE_RATE = 0.7;

function emptyFeedback(): ImplicitSongFeedback {
  return {
    skipCount: 0,
    completeCount: 0,
    removeCount: 0,
  };
}

function trimFeedback(feedback: Record<string, ImplicitSongFeedback>): Record<string, ImplicitSongFeedback> {
  const entries = Object.entries(feedback);
  if (entries.length <= MAX_FEEDBACK_ITEMS) return feedback;

  entries.sort(([, a], [, b]) => {
    const aTime = Math.max(a.lastSkippedAt ?? 0, a.lastCompletedAt ?? 0, a.lastRemovedAt ?? 0);
    const bTime = Math.max(b.lastSkippedAt ?? 0, b.lastCompletedAt ?? 0, b.lastRemovedAt ?? 0);
    return bTime - aTime;
  });

  return Object.fromEntries(entries.slice(0, MAX_FEEDBACK_ITEMS));
}

export const useImplicitFeedbackStore = create<ImplicitFeedbackState>()(
  persist(
    (set, get) => ({
      feedback: {},

      recordPlayback: (songId, progress, duration) => {
        if (duration <= 0) return;
        if (progress < MIN_MEANINGFUL_SECONDS) return;

        const key = String(songId);
        const completionRate = Math.max(0, Math.min(1, progress / duration));
        const isSkip = progress < SKIP_SECONDS || completionRate < SKIP_RATE;
        const isComplete = completionRate >= COMPLETE_RATE;

        if (!isSkip && !isComplete) return;

        const now = Date.now();
        set((state) => {
          const current = state.feedback[key] ?? emptyFeedback();
          const next: ImplicitSongFeedback = isSkip
            ? {
                ...current,
                skipCount: current.skipCount + 1,
                lastSkippedAt: now,
              }
            : {
                ...current,
                completeCount: current.completeCount + 1,
                lastCompletedAt: now,
              };

          return {
            feedback: trimFeedback({
              ...state.feedback,
              [key]: next,
            }),
          };
        });
      },

      recordQueueRemove: (songId) => {
        const key = String(songId);
        const now = Date.now();

        set((state) => {
          const current = state.feedback[key] ?? emptyFeedback();
          return {
            feedback: trimFeedback({
              ...state.feedback,
              [key]: {
                ...current,
                removeCount: current.removeCount + 1,
                lastRemovedAt: now,
              },
            }),
          };
        });
      },

      getFeedback: (songId) => get().feedback[String(songId)],
      clearFeedback: () => set({ feedback: {} }),
    }),
    { name: 'diva-implicit-feedback' },
  ),
);
