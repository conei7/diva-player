import { create } from 'zustand';

interface ProgressState {
  progress: number;
  duration: number;
  setProgress: (progress: number) => void;
  setDuration: (duration: number) => void;
  resetProgress: () => void;
}

export const useProgressStore = create<ProgressState>((set) => ({
  progress: 0,
  duration: 0,
  setProgress: (progress) => set({ progress }),
  setDuration: (duration) => set({ duration }),
  resetProgress: () => set({ progress: 0, duration: 0 }),
}));
