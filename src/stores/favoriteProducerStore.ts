import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { ArtistType } from '../types/vocadb';

export interface FavoriteProducer {
  id: number;
  name: string;
  artistType: Extract<ArtistType, 'Producer' | 'Circle' | 'Band'>;
  createdAt: number;
}

interface FavoriteProducerState {
  producers: FavoriteProducer[];
  addProducer: (producer: Omit<FavoriteProducer, 'createdAt'>) => void;
  removeProducer: (id: number) => void;
  toggleProducer: (producer: Omit<FavoriteProducer, 'createdAt'>) => boolean;
  isFavoriteProducer: (id: number) => boolean;
}

export function normalizeFavoriteProducers(value: unknown): FavoriteProducer[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(item => {
    if (!item || typeof item !== 'object') return [];
    const candidate = item as Partial<FavoriteProducer>;
    const candidateId = candidate.id;
    if (typeof candidateId !== 'number' || !Number.isInteger(candidateId) || candidateId <= 0 || typeof candidate.name !== 'string') return [];
    const id = candidateId;
    const artistType = candidate.artistType === 'Circle' || candidate.artistType === 'Band' ? candidate.artistType : 'Producer';
    return [{
      id,
      name: candidate.name.trim(),
      artistType,
      createdAt: Number.isFinite(candidate.createdAt) ? Number(candidate.createdAt) : Date.now(),
    }];
  });
}

export const useFavoriteProducerStore = create<FavoriteProducerState>()(
  persist(
    (set, get) => ({
      producers: [],
      addProducer: producer => set(state => state.producers.some(item => item.id === producer.id)
        ? state
        : { producers: [...state.producers, { ...producer, createdAt: Date.now() }] }),
      removeProducer: id => set(state => ({ producers: state.producers.filter(item => item.id !== id) })),
      toggleProducer: producer => {
        const exists = get().producers.some(item => item.id === producer.id);
        if (exists) get().removeProducer(producer.id);
        else get().addProducer(producer);
        return !exists;
      },
      isFavoriteProducer: id => get().producers.some(item => item.id === id),
    }),
    {
      name: 'diva-favorite-producers',
      version: 1,
      migrate: value => {
        if (!value || typeof value !== 'object') return { producers: [] };
        const raw = value as { producers?: unknown };
        return { producers: normalizeFavoriteProducers(raw.producers) };
      },
    },
  ),
);
