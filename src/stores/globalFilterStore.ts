import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type { SongType } from '../types/vocadb';

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
  cooldownHours: number;
  excludeRatedFromDiscovery: boolean;
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
  cooldownHours: 0,
  excludeRatedFromDiscovery: false,
};

const STORAGE_VERSION = 1;

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
        cooldownHours: state.cooldownHours,
        excludeRatedFromDiscovery: state.excludeRatedFromDiscovery,
      }),
    },
  ),
);

export function getGlobalFilterSettings(): GlobalFilterSettings {
  const { enabled, minYoutubeViews, minNicoViews, excludedSongTypes, cooldownHours, excludeRatedFromDiscovery } = useGlobalFilterStore.getState();
  return { enabled, minYoutubeViews, minNicoViews, excludedSongTypes, cooldownHours, excludeRatedFromDiscovery };
}
