import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type { SongType, VocalistMatchMode } from '../types/vocadb';

export const SONG_TYPES: SongType[] = [
  'Original',
  'Remaster',
  'Remix',
  'Cover',
  'Arrangement',
  'Instrumental',
  'Mashup',
  'MusicPV',
  'DramaPV',
  'Other',
  'Unspecified',
];

export interface GlobalFilterSettings {
  enabled: boolean;
  minYoutubeViews: number;
  minNicoViews: number;
  excludedSongTypes: SongType[];
  vocalistFilters: GlobalVocalistFilter[];
  vocalistMatchMode: VocalistMatchMode;
  cooldownHours: number;
  excludeRatedFromDiscovery: boolean;
}

export interface GlobalVocalistFilter {
  id: number;
  name: string;
  variantGroup?: string;
}

export interface GlobalFilterState extends GlobalFilterSettings {
  setSettings: (settings: Partial<GlobalFilterSettings>) => void;
  resetSettings: () => void;
}

export const DEFAULT_GLOBAL_FILTER_SETTINGS: GlobalFilterSettings = {
  enabled: false,
  minYoutubeViews: 0,
  minNicoViews: 0,
  excludedSongTypes: [],
  vocalistFilters: [],
  vocalistMatchMode: 'Any',
  cooldownHours: 0,
  excludeRatedFromDiscovery: false,
};

const STORAGE_VERSION = 2;

const memoryStorage = new Map<string, string>();
const safeStorage: Storage = {
  get length() { return memoryStorage.size; },
  clear: () => memoryStorage.clear(),
  getItem: key => memoryStorage.get(key) ?? null,
  key: index => [...memoryStorage.keys()][index] ?? null,
  removeItem: key => memoryStorage.delete(key),
  setItem: (key, value) => { memoryStorage.set(key, value); },
};

function isSongType(value: unknown): value is SongType {
  return typeof value === 'string' && SONG_TYPES.includes(value as SongType);
}

function normalizeNonNegativeInteger(value: unknown, fallback: number): number {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= 0
    ? value
    : fallback;
}

function normalizeVocalistFilters(value: unknown): GlobalVocalistFilter[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<number>();
  const normalized: GlobalVocalistFilter[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue;
    const candidate = item as Partial<GlobalVocalistFilter>;
    if (!Number.isSafeInteger(candidate.id) || (candidate.id ?? 0) <= 0 || typeof candidate.name !== 'string') continue;
    const id = candidate.id as number;
    const name = candidate.name.trim();
    if (!name || seen.has(id)) continue;
    seen.add(id);
    normalized.push({
      id,
      name,
      ...(typeof candidate.variantGroup === 'string' && candidate.variantGroup.trim()
        ? { variantGroup: candidate.variantGroup.trim() }
        : {}),
    });
  }
  return normalized.slice(0, 50);
}

export function normalizeGlobalFilterSettings(value: unknown): GlobalFilterSettings {
  const source = typeof value === 'object' && value !== null ? value as Partial<GlobalFilterSettings> : {};
  const excludedSongTypes = Array.isArray(source.excludedSongTypes)
    ? [...new Set(source.excludedSongTypes.filter(isSongType))]
    : DEFAULT_GLOBAL_FILTER_SETTINGS.excludedSongTypes;
  return {
    enabled: source.enabled === true,
    minYoutubeViews: normalizeNonNegativeInteger(source.minYoutubeViews, 0),
    minNicoViews: normalizeNonNegativeInteger(source.minNicoViews, 0),
    excludedSongTypes,
    vocalistFilters: normalizeVocalistFilters(source.vocalistFilters),
    vocalistMatchMode: source.vocalistMatchMode === 'All' || source.vocalistMatchMode === 'Exact'
      ? source.vocalistMatchMode
      : 'Any',
    cooldownHours: normalizeNonNegativeInteger(source.cooldownHours, 0),
    excludeRatedFromDiscovery: source.excludeRatedFromDiscovery === true,
  };
}

const storage = createJSONStorage<GlobalFilterSettings>(() => (
  typeof localStorage === 'undefined' ? safeStorage : localStorage
));

export const useGlobalFilterStore = create<GlobalFilterState>()(
  persist(
    (set) => ({
      ...DEFAULT_GLOBAL_FILTER_SETTINGS,
      setSettings: settings => set(state => normalizeGlobalFilterSettings({ ...state, ...settings })),
      resetSettings: () => set(DEFAULT_GLOBAL_FILTER_SETTINGS),
    }),
    {
      name: 'diva-global-filters',
      version: STORAGE_VERSION,
      storage,
      migrate: persisted => normalizeGlobalFilterSettings(persisted),
      partialize: state => ({
        enabled: state.enabled,
        minYoutubeViews: state.minYoutubeViews,
        minNicoViews: state.minNicoViews,
        excludedSongTypes: state.excludedSongTypes,
        vocalistFilters: state.vocalistFilters,
        vocalistMatchMode: state.vocalistMatchMode,
        cooldownHours: state.cooldownHours,
        excludeRatedFromDiscovery: state.excludeRatedFromDiscovery,
      }),
    },
  ),
);

export function getGlobalFilterSettings(): GlobalFilterSettings {
  const {
    enabled, minYoutubeViews, minNicoViews, excludedSongTypes,
    vocalistFilters, vocalistMatchMode, cooldownHours, excludeRatedFromDiscovery,
  } = useGlobalFilterStore.getState();
  return {
    enabled, minYoutubeViews, minNicoViews, excludedSongTypes,
    vocalistFilters, vocalistMatchMode, cooldownHours, excludeRatedFromDiscovery,
  };
}
