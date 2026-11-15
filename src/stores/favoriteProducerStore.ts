import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { ArtistType } from '../types/vocadb';

export interface FavoriteProducer {
  id: number;
  name: string;
  artistType: Extract<ArtistType, 'Producer' | 'Circle' | 'Band'>;
  createdAt: number;
  /** Publication cutoff explicitly acknowledged in the followed releases feed. */
  releasesCheckedAt?: number;
  checkedReleaseIds?: number[];
}

interface FavoriteProducerState {
  producers: FavoriteProducer[];
  addProducer: (producer: Omit<FavoriteProducer, 'createdAt'>) => void;
  removeProducer: (id: number) => void;
  toggleProducer: (producer: Omit<FavoriteProducer, 'createdAt'>) => boolean;
  isFavoriteProducer: (id: number) => boolean;
  markReleasesChecked: (producerIds: number[], checkedAt: number, songIds: number[]) => void;
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
      createdAt: typeof candidate.createdAt === 'number' && Number.isFinite(candidate.createdAt)
        && candidate.createdAt >= 0 && candidate.createdAt <= Date.now() ? candidate.createdAt : Date.now(),
      ...(typeof candidate.releasesCheckedAt === 'number' && Number.isFinite(candidate.releasesCheckedAt)
        && candidate.releasesCheckedAt >= 0 && candidate.releasesCheckedAt <= Date.now()
        ? { releasesCheckedAt: candidate.releasesCheckedAt } : {}),
      ...(Array.isArray(candidate.checkedReleaseIds) ? {
        checkedReleaseIds: [...new Set(candidate.checkedReleaseIds.filter(id => Number.isSafeInteger(id) && id > 0))],
      } : {}),
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
      markReleasesChecked: (producerIds, checkedAt, songIds) => {
        if (!Number.isFinite(checkedAt) || checkedAt < 0 || checkedAt > Date.now()) return;
        const ids = new Set(producerIds);
        const day = (at: number) => new Date(at + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
        set(state => ({ producers: state.producers.map(producer => {
          if (!ids.has(producer.id) || checkedAt < (producer.releasesCheckedAt ?? 0)) return producer;
          const sameDay = producer.releasesCheckedAt !== undefined && day(producer.releasesCheckedAt) === day(checkedAt);
          return { ...producer, releasesCheckedAt: checkedAt,
            checkedReleaseIds: [...new Set([...(sameDay ? producer.checkedReleaseIds ?? [] : []), ...songIds])]
              .filter(id => Number.isSafeInteger(id) && id > 0),
          };
        }) }));
      },
    }),
    {
      name: 'diva-favorite-producers',
      version: 1,
      merge: (persisted, current) => ({
        ...current,
        producers: normalizeFavoriteProducers((persisted as Partial<FavoriteProducerState> | undefined)?.producers),
      }),
      migrate: value => {
        if (!value || typeof value !== 'object') return { producers: [] };
        const raw = value as { producers?: unknown };
        return { producers: normalizeFavoriteProducers(raw.producers) };
      },
    },
  ),
);
