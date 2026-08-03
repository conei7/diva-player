import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Song } from '../types/vocadb';

export interface HiddenSongRecord {
  song: Song;
  hiddenAt: number;
}

interface HiddenSongState {
  hiddenSongs: Record<string, HiddenSongRecord>;
  hideSong: (song: Song) => void;
  restoreSong: (songId: string | number) => void;
  isHidden: (songId: string | number) => boolean;
  replaceHiddenSongs: (records: Record<string, HiddenSongRecord>) => void;
}

export function normalizeHiddenSongs(value: unknown): Record<string, HiddenSongRecord> {
  if (!value || typeof value !== 'object') return {};
  const normalized: Record<string, HiddenSongRecord> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!/^\d+$/.test(key) || !raw || typeof raw !== 'object') continue;
    const record = raw as Partial<HiddenSongRecord>;
    if (!record.song || record.song.id !== Number(key) || typeof record.song.name !== 'string') continue;
    normalized[key] = {
      song: record.song,
      hiddenAt: typeof record.hiddenAt === 'number' && Number.isFinite(record.hiddenAt)
        ? record.hiddenAt
        : Date.now(),
    };
  }
  return normalized;
}

export const useHiddenSongStore = create<HiddenSongState>()(
  persist(
    (set, get) => ({
      hiddenSongs: {},
      hideSong: song => set(state => ({
        hiddenSongs: {
          ...state.hiddenSongs,
          [String(song.id)]: { song, hiddenAt: Date.now() },
        },
      })),
      restoreSong: songId => set(state => {
        const next = { ...state.hiddenSongs };
        delete next[String(songId)];
        return { hiddenSongs: next };
      }),
      isHidden: songId => Boolean(get().hiddenSongs[String(songId)]),
      replaceHiddenSongs: records => set({ hiddenSongs: normalizeHiddenSongs(records) }),
    }),
    {
      name: 'diva-hidden-songs',
      merge: (persisted, current) => ({
        ...current,
        ...(persisted && typeof persisted === 'object' ? persisted : {}),
        hiddenSongs: normalizeHiddenSongs((persisted as Partial<HiddenSongState> | undefined)?.hiddenSongs),
      }),
    },
  ),
);

export function getHiddenSongIds(): Set<number> {
  return new Set(Object.keys(useHiddenSongStore.getState().hiddenSongs).map(Number));
}

export function excludeHiddenSongs(songs: Song[], records: Record<string, HiddenSongRecord>): Song[] {
  return songs.filter(song => !records[String(song.id)]);
}
