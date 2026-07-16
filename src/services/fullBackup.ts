import type { ListeningPlayEvent } from '../stores/historyStore';
import type { Playlist, PlaylistFolder, Song } from '../types/vocadb';
import { useHistoryStore } from '../stores/historyStore';
import { usePlaylistStore, WATCH_LATER_ID } from '../stores/playlistStore';
import { useRatingStore } from '../stores/ratingStore';
import { storage } from '../utils/storage';
import { HISTORY_STORES, openHistoryDb } from './historyDatabase';
import { normalizeImportedEvent, playEventFingerprint } from './historyBackup';
import { downloadJson } from '../utils/playlistBackup';
import {
  getGlobalFilterSettings,
  normalizeGlobalFilterSettings,
  useGlobalFilterStore,
  type GlobalFilterSettings,
} from '../stores/globalFilterStore';
import { normalizeFavoriteProducers, useFavoriteProducerStore, type FavoriteProducer } from '../stores/favoriteProducerStore';

const BACKUP_KIND = 'diva-player-full-backup';
const BACKUP_VERSION = 3 as const;
type SupportedBackupVersion = 1 | 2 | 3;
const MAX_HISTORY_EVENTS = 1_000_000;
const MAX_PLAYLISTS = 10_000;

export interface FullBackupPayload {
  kind: typeof BACKUP_KIND;
  version: SupportedBackupVersion;
  exportedAt: string;
  sections: {
    history: { events: ListeningPlayEvent[] };
    ratings: Record<string, number>;
    playlists: { folders: PlaylistFolder[]; playlists: Playlist[] };
    preferences?: { globalFilters: GlobalFilterSettings; favoriteProducers?: FavoriteProducer[] };
  };
}

export interface FullBackupPreview {
  historyCount: number;
  ratingCount: number;
  playlistCount: number;
  folderCount: number;
  invalidItems: number;
  preferencesIncluded: boolean;
  parsed: FullBackupPayload;
}

export interface FullBackupImportOptions {
  mode: 'merge' | 'replace';
  ratingPriority: 'backup' | 'current';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function finiteInteger(value: unknown, min = 0): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && Number.isFinite(value) && value >= min
    ? value
    : undefined;
}

function parseSong(value: unknown): Song | null {
  if (!isRecord(value) || finiteInteger(value.id, 1) === undefined || typeof value.name !== 'string') return null;
  const song = value as Partial<Song>;
  return {
    id: value.id as number,
    name: value.name,
    defaultName: typeof value.defaultName === 'string' ? value.defaultName : value.name,
    defaultNameLanguage: typeof value.defaultNameLanguage === 'string' ? value.defaultNameLanguage : 'Unspecified',
    artistString: typeof value.artistString === 'string' ? value.artistString : '',
    createDate: typeof value.createDate === 'string' ? value.createDate : '',
    favoritedTimes: typeof value.favoritedTimes === 'number' ? value.favoritedTimes : 0,
    lengthSeconds: typeof value.lengthSeconds === 'number' ? value.lengthSeconds : 0,
    originalVersionId: typeof value.originalVersionId === 'number' ? value.originalVersionId : undefined,
    publishDate: typeof value.publishDate === 'string' ? value.publishDate : undefined,
    pvs: Array.isArray(value.pvs) ? value.pvs as Song['pvs'] : undefined,
    pvServices: typeof value.pvServices === 'string' ? value.pvServices : '',
    ratingScore: typeof value.ratingScore === 'number' ? value.ratingScore : 0,
    songType: typeof value.songType === 'string' ? value.songType as Song['songType'] : 'Original',
    status: typeof value.status === 'string' ? value.status : 'Finished',
    tags: Array.isArray(value.tags) ? value.tags as Song['tags'] : undefined,
    thumbUrl: typeof value.thumbUrl === 'string' ? value.thumbUrl : undefined,
    version: typeof value.version === 'number' ? value.version : 0,
    youtubeViews: typeof song.youtubeViews === 'number' ? song.youtubeViews : undefined,
    nicoViews: typeof song.nicoViews === 'number' ? song.nicoViews : undefined,
    audioComputed: typeof song.audioComputed === 'boolean' ? song.audioComputed : undefined,
  };
}

function parseFolder(value: unknown): PlaylistFolder | null {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.name !== 'string') return null;
  return {
    id: value.id,
    name: value.name,
    parentId: typeof value.parentId === 'string' ? value.parentId : undefined,
    createdAt: finiteInteger(value.createdAt) ?? Date.now(),
    updatedAt: finiteInteger(value.updatedAt) ?? Date.now(),
  };
}

function parsePlaylist(value: unknown): Playlist | null {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.name !== 'string' || !Array.isArray(value.songs)) return null;
  const songs = value.songs.map(parseSong).filter((song): song is Song => song !== null);
  if (songs.length !== value.songs.length) return null;
  return {
    id: value.id,
    name: value.name,
    description: typeof value.description === 'string' ? value.description : undefined,
    coverArtUrl: typeof value.coverArtUrl === 'string' ? value.coverArtUrl : undefined,
    folderId: typeof value.folderId === 'string' ? value.folderId : undefined,
    songs,
    createdAt: finiteInteger(value.createdAt) ?? Date.now(),
    updatedAt: finiteInteger(value.updatedAt) ?? Date.now(),
    isPinned: value.isPinned === true,
  };
}

function copyRatings(value: unknown, onInvalid: () => void): Record<string, number> {
  if (!isRecord(value)) return {};
  const ratings: Record<string, number> = {};
  for (const [key, rating] of Object.entries(value)) {
    if (/^\d+$/.test(key) && typeof rating === 'number' && Number.isInteger(rating) && rating >= 1 && rating <= 5) ratings[key] = rating;
    else onInvalid();
  }
  return ratings;
}

export async function createFullBackup(): Promise<FullBackupPayload> {
  const db = await openHistoryDb();
  const historyTx = db.transaction(HISTORY_STORES.plays, 'readonly');
  const events = await new Promise<ListeningPlayEvent[]>((resolve, reject) => {
    const request = historyTx.objectStore(HISTORY_STORES.plays).getAll();
    request.onsuccess = () => resolve((request.result as ListeningPlayEvent[])
      .filter(event => event.f !== 0)
      .map(event => {
        const copy = { ...event };
        delete copy.id;
        return copy;
      }));
    request.onerror = () => reject(request.error);
  });
  const { playlists, folders } = usePlaylistStore.getState();
  return {
    kind: BACKUP_KIND,
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    sections: {
      history: { events },
      ratings: { ...useRatingStore.getState().ratings },
      playlists: {
        folders: folders.map(folder => ({ ...folder })),
        playlists: playlists.map(playlist => ({ ...playlist, songs: playlist.songs.map(song => ({ ...song })) })),
      },
      preferences: {
        globalFilters: getGlobalFilterSettings(),
        favoriteProducers: useFavoriteProducerStore.getState().producers.map(producer => ({ ...producer })),
      },
    },
  };
}

export function downloadFullBackup(payload: FullBackupPayload): void {
  downloadJson(`diva_full_backup_${payload.exportedAt.slice(0, 10)}.json`, payload);
}

export function parseFullBackup(data: unknown): FullBackupPreview | null {
  if (!isRecord(data) || data.kind !== BACKUP_KIND || (data.version !== 1 && data.version !== 2 && data.version !== BACKUP_VERSION) || !isRecord(data.sections)) return null;
  let invalidItems = 0;
  const rawHistory = isRecord(data.sections.history) && Array.isArray(data.sections.history.events) ? data.sections.history.events : [];
  if (rawHistory.length > MAX_HISTORY_EVENTS) return null;
  const events = rawHistory.map(normalizeImportedEvent).filter((event): event is ListeningPlayEvent => {
    if (!event) invalidItems += 1;
    return event !== null;
  });
  const ratings = copyRatings(data.sections.ratings, () => { invalidItems += 1; });
  const rawPlaylists = isRecord(data.sections.playlists) ? data.sections.playlists : {};
  const rawFolders = Array.isArray(rawPlaylists.folders) ? rawPlaylists.folders : [];
  const rawItems = Array.isArray(rawPlaylists.playlists) ? rawPlaylists.playlists : [];
  if (rawItems.length > MAX_PLAYLISTS) return null;
  const folders = rawFolders.map(parseFolder).filter((folder): folder is PlaylistFolder => {
    if (!folder) invalidItems += 1;
    return folder !== null;
  });
  const playlists = rawItems.map(parsePlaylist).filter((playlist): playlist is Playlist => {
    if (!playlist) invalidItems += 1;
    return playlist !== null;
  });
  const rawPreferences = isRecord(data.sections.preferences) ? data.sections.preferences : undefined;
  const rawGlobalFilters = rawPreferences && isRecord(rawPreferences.globalFilters)
    ? rawPreferences.globalFilters
    : undefined;
  if (rawPreferences && !rawGlobalFilters) invalidItems += 1;
  const rawFavoriteProducers = rawPreferences && 'favoriteProducers' in rawPreferences
    ? normalizeFavoriteProducers(rawPreferences.favoriteProducers)
    : undefined;
  const parsed: FullBackupPayload = {
    kind: BACKUP_KIND,
    version: data.version as SupportedBackupVersion,
    exportedAt: typeof data.exportedAt === 'string' ? data.exportedAt : new Date().toISOString(),
    sections: {
      history: { events },
      ratings,
      playlists: { folders, playlists },
      ...(rawGlobalFilters ? {
        preferences: {
          globalFilters: normalizeGlobalFilterSettings(rawGlobalFilters),
          ...(rawFavoriteProducers ? { favoriteProducers: rawFavoriteProducers } : {}),
        },
      } : {}),
    },
  };
  return {
    historyCount: events.length,
    ratingCount: Object.keys(ratings).length,
    playlistCount: playlists.length,
    folderCount: folders.length,
    invalidItems,
    preferencesIncluded: rawGlobalFilters !== undefined,
    parsed,
  };
}

function transactionToPromise(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

async function replaceHistory(events: ListeningPlayEvent[]): Promise<void> {
  const db = await openHistoryDb();
  const tx = db.transaction(Object.values(HISTORY_STORES), 'readwrite');
  for (const storeName of Object.values(HISTORY_STORES)) tx.objectStore(storeName).clear();
  const plays = tx.objectStore(HISTORY_STORES.plays);
  const pending = tx.objectStore(HISTORY_STORES.pending);
  for (const event of events) {
    const request = plays.add(event);
    request.onsuccess = () => {
      const id = Number(request.result);
      if (event.f !== 0) pending.put({ eventId: id });
    };
  }
  await transactionToPromise(tx);
}

async function readAllHistoryEvents(): Promise<ListeningPlayEvent[]> {
  const db = await openHistoryDb();
  const tx = db.transaction(HISTORY_STORES.plays, 'readonly');
  return new Promise<ListeningPlayEvent[]>((resolve, reject) => {
    const request = tx.objectStore(HISTORY_STORES.plays).getAll();
    request.onsuccess = () => resolve(request.result as ListeningPlayEvent[]);
    request.onerror = () => reject(request.error);
  });
}

async function mergeHistory(events: ListeningPlayEvent[]): Promise<void> {
  const db = await openHistoryDb();
  const readTx = db.transaction(HISTORY_STORES.plays, 'readonly');
  const existing = await new Promise<ListeningPlayEvent[]>((resolve, reject) => {
    const request = readTx.objectStore(HISTORY_STORES.plays).getAll();
    request.onsuccess = () => resolve(request.result as ListeningPlayEvent[]);
    request.onerror = () => reject(request.error);
  });
  const fingerprints = new Set(existing.map(playEventFingerprint));
  const additions = events.filter(event => !fingerprints.has(playEventFingerprint(event)));
  if (additions.length === 0) return;
  const tx = db.transaction(Object.values(HISTORY_STORES), 'readwrite');
  const plays = tx.objectStore(HISTORY_STORES.plays);
  for (const event of additions) plays.add(event);
  tx.objectStore(HISTORY_STORES.pending).clear();
  tx.objectStore(HISTORY_STORES.applied).clear();
  tx.objectStore(HISTORY_STORES.songStats).clear();
  tx.objectStore(HISTORY_STORES.yearStats).clear();
  tx.objectStore(HISTORY_STORES.monthStats).clear();
  tx.objectStore(HISTORY_STORES.meta).clear();
  await transactionToPromise(tx);
}

function uniqueId(existing: Set<string>, candidate: string): string {
  if (!existing.has(candidate)) return candidate;
  let next = crypto.randomUUID();
  while (existing.has(next)) next = crypto.randomUUID();
  return next;
}

function mergePlaylists(current: Playlist[], incoming: Playlist[], currentFolders: PlaylistFolder[], incomingFolders: PlaylistFolder[]): { playlists: Playlist[]; folders: PlaylistFolder[] } {
  const folderIds = new Set(currentFolders.map(folder => folder.id));
  const folders = [...currentFolders, ...incomingFolders.filter(folder => !folderIds.has(folder.id))];
  const playlistIds = new Set(current.map(playlist => playlist.id));
  const imported = incoming.map(playlist => {
    const id = uniqueId(playlistIds, playlist.id);
    playlistIds.add(id);
    return { ...playlist, id };
  });
  const playlists = [...current, ...imported];
  return { playlists, folders };
}

export async function executeFullBackupImport(preview: FullBackupPreview, options: FullBackupImportOptions): Promise<void> {
  const currentRatings = { ...useRatingStore.getState().ratings };
  const currentPlaylists = usePlaylistStore.getState().playlists.map(playlist => ({ ...playlist, songs: [...playlist.songs] }));
  const currentFolders = usePlaylistStore.getState().folders.map(folder => ({ ...folder }));
  const currentGlobalFilters = getGlobalFilterSettings();
  const currentFavoriteProducers = useFavoriteProducerStore.getState().producers.map(producer => ({ ...producer }));
  const currentHistory = await readAllHistoryEvents();
  try {
    const incoming = preview.parsed.sections;
    const merged = options.mode === 'replace'
      ? null
      : mergePlaylists(currentPlaylists, incoming.playlists.playlists, currentFolders, incoming.playlists.folders);
    const nextPlaylists = options.mode === 'replace' ? incoming.playlists.playlists : merged!.playlists;
    const nextFolders = options.mode === 'replace' ? incoming.playlists.folders : merged!.folders;
    if (!nextPlaylists.some(playlist => playlist.id === WATCH_LATER_ID)) {
      const watchLater = currentPlaylists.find(playlist => playlist.id === WATCH_LATER_ID);
      if (watchLater) nextPlaylists.unshift(watchLater);
    }
    if (!storage.set('playlists', nextPlaylists) || !storage.set('playlistFolders', nextFolders)) throw new Error('playlist storage write failed');
    usePlaylistStore.getState().loadPlaylists();

    const nextRatings = options.mode === 'replace'
      ? { ...incoming.ratings }
      : options.ratingPriority === 'backup' ? { ...currentRatings, ...incoming.ratings } : { ...incoming.ratings, ...currentRatings };
    useRatingStore.setState({ ratings: nextRatings });
    if (options.mode === 'replace' && incoming.preferences?.globalFilters) {
      useGlobalFilterStore.getState().setSettings(incoming.preferences.globalFilters);
    }
    const incomingFavoriteProducers = incoming.preferences?.favoriteProducers;
    if (incomingFavoriteProducers) {
      const favoriteById = new Map<number, FavoriteProducer>();
      if (options.mode !== 'replace') currentFavoriteProducers.forEach(producer => favoriteById.set(producer.id, producer));
      incomingFavoriteProducers.forEach(producer => favoriteById.set(producer.id, producer));
      useFavoriteProducerStore.setState({ producers: [...favoriteById.values()] });
    }
    if (options.mode === 'replace') await replaceHistory(incoming.history.events);
    else await mergeHistory(incoming.history.events);
    await useHistoryStore.getState().reloadHistory();
  } catch (error) {
    storage.set('playlists', currentPlaylists);
    storage.set('playlistFolders', currentFolders);
    usePlaylistStore.getState().loadPlaylists();
    useRatingStore.setState({ ratings: currentRatings });
    useGlobalFilterStore.getState().setSettings(currentGlobalFilters);
    useFavoriteProducerStore.setState({ producers: currentFavoriteProducers });
    try {
      await replaceHistory(currentHistory);
      await useHistoryStore.getState().reloadHistory();
    } catch (rollbackError) {
      console.error('[FullBackup] History rollback failed', rollbackError);
    }
    throw error;
  }
}
