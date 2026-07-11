import { create } from 'zustand';
import type { AutoQueueStatus } from '../types/autoplay';

interface AutoQueueStatusState {
  status: AutoQueueStatus;
  setStatus: (status: AutoQueueStatus) => void;
}

export const useAutoQueueStatusStore = create<AutoQueueStatusState>()(set => ({
  status: 'idle',
  setStatus: (status) => set({ status }),
}));
