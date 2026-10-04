import type { ListeningPlayEvent } from '../stores/historyStore';
import type { Playlist, PlaylistFolder, Song, SmartPlaylistRule } from '../types/vocadb';
import { normalizeSmartPlaylistRule } from '../utils/smartPlaylist';
import { useHistoryStore } from '../stores/historyStore';
import { LEGACY_DIG_PLAYLIST_ID, usePlaylistStore, WATCH_LATER_ID } from '../stores/playlistStore';
import { useRatingStore } from '../stores/ratingStore';
import { storage } from '../utils/storage';
import { HISTORY_STORES, openHistoryDb } from './historyDatabase';
import { normalizeImportedEvent, playEventFingerprint } from './historyBackup';
import { downloadJson, parseNicoPlaylistSync, parseYouTubePlaylistSync } from '../utils/playlistBackup';
import {
  getGlobalFilterSettings,
  normalizeGlobalFilterSettings,
  useGlobalFilterStore,
  type GlobalFilterSettings,
} from '../stores/globalFilterStore';
import { normalizeFavoriteProducers, useFavoriteProducerStore, type FavoriteProducer } from '../stores/favoriteProducerStore';
import { createStableId } from '../utils/id';
import { normalizeHiddenSongs, useHiddenSongStore, type HiddenSongRecord } from '../stores/hiddenSongStore';

const BACKUP_KIND = 'diva-player-full-backup';
const BACKUP_VERSION = 6 as const;
type SupportedBackupVersion = 1 | 2 | 3 | 4 | 5 | 6;
const MAX_HISTORY_EVENTS = 1_000_000;
const MAX_PLAYLISTS = 10_000;

export class FullBackupImportError extends Error {
  readonly recoveryComplete: boolean;
  readonly rollbackErrors: string[];

  constructor(
    message: string,
    recoveryComplete: boolean,
    rollbackErrors: string[] = [],
  ) {
    super(message);
    this.name = 'FullBackupImportError';
    this.recoveryComplete = recoveryComplete;
    this.rollbackErrors = rollbackErrors;
  }
}

export interface FullBackupPayload {
  kind: typeof BACKUP_KIND;
  version: SupportedBackupVersion;
  exportedAt: string;
  manifest?: FullBackupManifest;
  sections: {
    history: { events: ListeningPlayEvent[] };
    ratings: Record<string, number>;
    playlists: { folders: PlaylistFolder[]; playlists: Playlist[] };
    hiddenSongs: Record<string, HiddenSongRecord>;
    preferences?: { globalFilters: GlobalFilterSettings; favoriteProducers?: FavoriteProducer[] };
  };
}

export interface FullBackupCounts {
  historyEvents: number;
  ratingCount: number;
  playlistCount: number;
  playlistSongCount: number;
  folderCount: number;
  favoriteProducerCount: number;
  hiddenSongCount: number;
}

export interface FullBackupManifest extends FullBackupCounts {
  schemaVersion: 4 | 5 | 6;
}

export interface FullBackupPreview {
  historyCount: number;
  ratingCount: number;
  playlistCount: number;
  playlistSongCount: number;
  folderCount: number;
  favoriteProducerCount: number;
  hiddenSongCount: number;
  invalidItems: number;
  preferencesIncluded: boolean;
  manifestValid: boolean;
  legacyFormat: boolean;
  canRestore: boolean;
  validationMessages: string[];
  parsed: FullBackupPayload;
}

export interface FullBackupImportResult {
  before: FullBackupCounts;
  after: FullBackupCounts;
  mode: FullBackupImportOptions['mode'];
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
    smartRule: parseSmartRule(value.smartRule),
    youtubeSync: parseYouTubePlaylistSync(value.youtubeSync),
    nicoSync: parseNicoPlaylistSync(value.nicoSync),
  };
}

function parseSmartRule(value: unknown): SmartPlaylistRule | undefined {
  if (!isRecord(value)) return undefined;
  const excludedSongTypes = Array.isArray(value.excludedSongTypes)
    ? value.excludedSongTypes.filter((item): item is SmartPlaylistRule['excludedSongTypes'][number] => typeof item === 'string' && [
      'Original', 'Remaster', 'Remix', 'Cover', 'Arrangement', 'Instrumental', 'Mashup', 'MusicPV', 'DramaPV', 'Other', 'Unspecified',
    ].includes(item))
    : [];
  if (typeof value.minYoutubeViews !== 'number' || !Number.isInteger(value.minYoutubeViews) || value.minYoutubeViews < 0) return undefined;
  if (typeof value.minNicoViews !== 'number' || !Number.isInteger(value.minNicoViews) || value.minNicoViews < 0) return undefined;
  const producerId = finiteInteger(value.producerId, 1);
  return normalizeSmartPlaylistRule({
    minYoutubeViews: value.minYoutubeViews,
    minNicoViews: value.minNicoViews,
    excludedSongTypes,
    maxSongs: value.maxSongs as SmartPlaylistRule['maxSongs'],
    sortBy: value.sortBy as SmartPlaylistRule['sortBy'],
    producerId,
    producerName: typeof value.producerName === 'string' ? value.producerName : undefined,
    publishYearFrom: typeof value.publishYearFrom === 'string' ? value.publishYearFrom : undefined,
    publishYearTo: typeof value.publishYearTo === 'string' ? value.publishYearTo : undefined,
    lengthMinSeconds: typeof value.lengthMinSeconds === 'string' ? value.lengthMinSeconds : undefined,
    lengthMaxSeconds: typeof value.lengthMaxSeconds === 'string' ? value.lengthMaxSeconds : undefined,
    pvService: value.pvService as SmartPlaylistRule['pvService'],
    audioComputed: value.audioComputed as SmartPlaylistRule['audioComputed'],
  });
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

function copyHiddenSongs(value: unknown, onInvalid: () => void): Record<string, HiddenSongRecord> {
  if (!isRecord(value)) return {};
  const hiddenSongs: Record<string, HiddenSongRecord> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!/^\d+$/.test(key) || !isRecord(raw)) {
      onInvalid();
      continue;
    }
    const song = parseSong(raw.song);
    const hiddenAt = finiteInteger(raw.hiddenAt);
    if (!song || song.id !== Number(key) || hiddenAt === undefined) {
      onInvalid();
      continue;
    }
    hiddenSongs[key] = { song, hiddenAt };
  }
  return hiddenSongs;
}

function getCountsFromSections(sections: FullBackupPayload['sections']): FullBackupCounts {
  return {
    historyEvents: sections.history.events.length,
    ratingCount: Object.keys(sections.ratings).length,
    playlistCount: sections.playlists.playlists.length,
    playlistSongCount: sections.playlists.playlists.reduce((total, playlist) => total + playlist.songs.length, 0),
    folderCount: sections.playlists.folders.length,
    favoriteProducerCount: sections.preferences?.favoriteProducers?.length ?? 0,
    hiddenSongCount: Object.keys(sections.hiddenSongs).length,
  };
}

function createManifest(sections: FullBackupPayload['sections']): FullBackupManifest {
  return { schemaVersion: BACKUP_VERSION, ...getCountsFromSections(sections) };
}

function manifestMatches(manifest: unknown, counts: FullBackupCounts, schemaVersion: 4 | 5 | 6): boolean {
  if (!isRecord(manifest) || manifest.schemaVersion !== schemaVersion) return false;
  const keys = Object.keys(counts).filter(key => schemaVersion >= 6 || key !== 'hiddenSongCount');
  return keys.every(key => manifest[key] === counts[key as keyof FullBackupCounts]);
}

export function getCurrentBackupCounts(payload: FullBackupPayload): FullBackupCounts {
  return getCountsFromSections(payload.sections);
}

export function readPersistedPlaylistsForBackup(): Pick<FullBackupPayload['sections']['playlists'], 'folders' | 'playlists'> {
  // playlistStore is hydrated lazily by PlaylistPage. A backup can also be
  // started directly from another page, so load the persisted data explicitly.
  usePlaylistStore.getState().loadPlaylists();
  const { playlists, folders } = usePlaylistStore.getState();
  return { playlists, folders };
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
  const { playlists, folders } = readPersistedPlaylistsForBackup();
  const sections: FullBackupPayload['sections'] = {
    history: { events },
    ratings: { ...useRatingStore.getState().ratings },
    playlists: {
      folders: folders.map(folder => ({ ...folder })),
      playlists: playlists.map(playlist => ({ ...playlist, songs: playlist.songs.map(song => ({ ...song })) })),
    },
    hiddenSongs: normalizeHiddenSongs(useHiddenSongStore.getState().hiddenSongs),
    preferences: {
      globalFilters: getGlobalFilterSettings(),
      favoriteProducers: useFavoriteProducerStore.getState().producers.map(producer => ({ ...producer })),
    },
  };
  return {
    kind: BACKUP_KIND,
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    manifest: createManifest(sections),
    sections,
  };
}

export async function readCurrentBackupCounts(): Promise<FullBackupCounts> {
  return getCurrentBackupCounts(await createFullBackup());
}

export function downloadFullBackup(payload: FullBackupPayload): void {
  downloadJson(`diva_full_backup_${payload.exportedAt.slice(0, 10)}.json`, payload);
}

export function parseFullBackup(data: unknown): FullBackupPreview | null {
  if (!isRecord(data) || data.kind !== BACKUP_KIND || ![1, 2, 3, 4, 5, BACKUP_VERSION].includes(data.version as number) || !isRecord(data.sections)) return null;
  const version = data.version as SupportedBackupVersion;
  let invalidItems = 0;
  const validationMessages: string[] = [];
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
  const hiddenSongs = version >= 6
    ? copyHiddenSongs(data.sections.hiddenSongs, () => { invalidItems += 1; })
    : {};
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
    version,
    exportedAt: typeof data.exportedAt === 'string' ? data.exportedAt : new Date().toISOString(),
    ...(version >= 4 && isRecord(data.manifest) ? { manifest: data.manifest as unknown as FullBackupManifest } : {}),
    sections: {
      history: { events },
      ratings,
      playlists: { folders, playlists },
      hiddenSongs,
      ...(rawGlobalFilters ? {
        preferences: {
          globalFilters: normalizeGlobalFilterSettings(rawGlobalFilters),
          ...(rawFavoriteProducers ? { favoriteProducers: rawFavoriteProducers } : {}),
        },
      } : {}),
    },
  };
  const counts = getCountsFromSections(parsed.sections);
  const legacyFormat = version < 4;
  const manifestValid = legacyFormat || manifestMatches(data.manifest, counts, version as 4 | 5 | 6);
  if (legacyFormat) validationMessages.push('旧形式のバックアップです。内容の件数検証は行われません。');
  if (version >= 4 && !manifestValid) validationMessages.push('manifestと実データの件数が一致しません。');
  if (invalidItems > 0) validationMessages.push(`${invalidItems}件の無効な項目があります。`);
  const canRestore = manifestValid && invalidItems === 0;
  return {
    historyCount: events.length,
    ratingCount: Object.keys(ratings).length,
    playlistCount: playlists.length,
    playlistSongCount: counts.playlistSongCount,
    folderCount: folders.length,
    favoriteProducerCount: counts.favoriteProducerCount,
    hiddenSongCount: counts.hiddenSongCount,
    invalidItems,
    preferencesIncluded: rawGlobalFilters !== undefined,
    manifestValid,
    legacyFormat,
    canRestore,
    validationMessages,
    parsed,
  };
}

type HistoryStoreSnapshot = Record<string, unknown[]>;

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

async function readHistoryStoreSnapshot(): Promise<HistoryStoreSnapshot> {
  const db = await openHistoryDb();
  const storeNames = Object.values(HISTORY_STORES);
  const tx = db.transaction(storeNames, 'readonly');
  const snapshot: HistoryStoreSnapshot = Object.fromEntries(storeNames.map(name => [name, []]));
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
    for (const name of storeNames) {
      const request = tx.objectStore(name).getAll();
      request.onsuccess = () => { snapshot[name] = request.result as unknown[]; };
      request.onerror = () => reject(request.error);
    }
  });
  return snapshot;
}

async function restoreHistoryStoreSnapshot(snapshot: HistoryStoreSnapshot): Promise<void> {
  const db = await openHistoryDb();
  const storeNames = Object.values(HISTORY_STORES);
  const tx = db.transaction(storeNames, 'readwrite');
  for (const name of storeNames) {
    const store = tx.objectStore(name);
    store.clear();
    for (const value of snapshot[name] ?? []) store.put(value);
  }
  await transactionToPromise(tx);
}

async function mergeHistory(events: ListeningPlayEvent[]): Promise<boolean> {
  const db = await openHistoryDb();
  const readTx = db.transaction(HISTORY_STORES.plays, 'readonly');
  const existing = await new Promise<ListeningPlayEvent[]>((resolve, reject) => {
    const request = readTx.objectStore(HISTORY_STORES.plays).getAll();
    request.onsuccess = () => resolve(request.result as ListeningPlayEvent[]);
    request.onerror = () => reject(request.error);
  });
  const fingerprints = new Set(existing.map(playEventFingerprint));
  const additions = events.filter(event => !fingerprints.has(playEventFingerprint(event)));
  if (additions.length === 0) return false;
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
  return true;
}

function uniqueId(existing: Set<string>, candidate: string): string {
  if (!existing.has(candidate)) return candidate;
  let next = createStableId('import');
  while (existing.has(next)) next = createStableId('import');
  return next;
}

function mergePlaylists(current: Playlist[], incoming: Playlist[], currentFolders: PlaylistFolder[], incomingFolders: PlaylistFolder[]): { playlists: Playlist[]; folders: PlaylistFolder[] } {
  const folderIds = new Set(currentFolders.map(folder => folder.id));
  const folders = [...currentFolders, ...incomingFolders.filter(folder => !folderIds.has(folder.id))];
  const retained = current.filter(playlist => playlist.id !== LEGACY_DIG_PLAYLIST_ID);
  const playlistIds = new Set(retained.map(playlist => playlist.id));
  const imported = incoming.filter(playlist => playlist.id !== LEGACY_DIG_PLAYLIST_ID).map(playlist => {
    const id = uniqueId(playlistIds, playlist.id);
    playlistIds.add(id);
    return { ...playlist, id };
  });
  return { playlists: [...retained, ...imported], folders };
}

export async function executeFullBackupImport(preview: FullBackupPreview, options: FullBackupImportOptions): Promise<FullBackupImportResult> {
  const validatedPreview = parseFullBackup(preview?.parsed);
  if (preview?.canRestore !== true || !validatedPreview?.canRestore) {
    throw new FullBackupImportError('検証に合格していないバックアップは復元できません。', true);
  }
  const currentRatings = { ...useRatingStore.getState().ratings };
  const currentPlaylists = usePlaylistStore.getState().playlists.map(playlist => ({ ...playlist, songs: [...playlist.songs] }));
  const currentFolders = usePlaylistStore.getState().folders.map(folder => ({ ...folder }));
  const currentGlobalFilters = getGlobalFilterSettings();
  const currentFavoriteProducers = useFavoriteProducerStore.getState().producers.map(producer => ({ ...producer }));
  const currentHiddenSongs = normalizeHiddenSongs(useHiddenSongStore.getState().hiddenSongs);
  let currentHistorySnapshot: HistoryStoreSnapshot;
  try {
    currentHistorySnapshot = await readHistoryStoreSnapshot();
  } catch (error) {
    throw new FullBackupImportError(
      `復元前の履歴を読み取れませんでした: ${error instanceof Error ? error.message : String(error)}`,
      true,
    );
  }
  const currentHistory = currentHistorySnapshot[HISTORY_STORES.plays] as ListeningPlayEvent[];
  const storageKeys = [
    'diva_playlists',
    'diva_playlistFolders',
    'diva-ratings',
    'diva-hidden-songs',
    'diva-global-filters',
    'diva-favorite-producers',
  ];
  const storageSnapshot = new Map<string, string | null>();
  try {
    if (typeof localStorage !== 'undefined') {
      for (const key of storageKeys) storageSnapshot.set(key, localStorage.getItem(key));
    }
  } catch (error) {
    throw new FullBackupImportError(
      `復元前の保存状態を読み取れませんでした: ${error instanceof Error ? error.message : String(error)}`,
      true,
    );
  }
  const changed = { playlists: false, ratings: false, hiddenSongs: false, globalFilters: false, favoriteProducers: false, history: false };
  try {
    const incoming = validatedPreview.parsed.sections;
    const merged = options.mode === 'replace'
      ? null
      : mergePlaylists(currentPlaylists, incoming.playlists.playlists, currentFolders, incoming.playlists.folders);
    const nextPlaylists = options.mode === 'replace'
      ? incoming.playlists.playlists.filter(playlist => playlist.id !== LEGACY_DIG_PLAYLIST_ID)
      : merged!.playlists;
    const nextFolders = options.mode === 'replace' ? incoming.playlists.folders : merged!.folders;
    if (!nextPlaylists.some(playlist => playlist.id === WATCH_LATER_ID)) {
      const watchLater = currentPlaylists.find(playlist => playlist.id === WATCH_LATER_ID);
      if (watchLater) nextPlaylists.unshift(watchLater);
    }
    changed.playlists = true;
    const playlistWrite = storage.setMany([
      { key: 'playlists', value: nextPlaylists },
      { key: 'playlistFolders', value: nextFolders },
    ]);
    if (!playlistWrite.success) throw new Error('プレイリストまたはフォルダを保存できませんでした。');
    usePlaylistStore.setState({ playlists: nextPlaylists, folders: nextFolders });

    const nextRatings = options.mode === 'replace'
      ? { ...incoming.ratings }
      : options.ratingPriority === 'backup' ? { ...currentRatings, ...incoming.ratings } : { ...incoming.ratings, ...currentRatings };
    changed.ratings = true;
    useRatingStore.setState({ ratings: nextRatings });
    const nextHiddenSongs = options.mode === 'replace'
      ? incoming.hiddenSongs
      : { ...currentHiddenSongs, ...incoming.hiddenSongs };
    changed.hiddenSongs = true;
    useHiddenSongStore.getState().replaceHiddenSongs(nextHiddenSongs);
    if (options.mode === 'replace' && incoming.preferences?.globalFilters) {
      changed.globalFilters = true;
      useGlobalFilterStore.getState().setSettings(incoming.preferences.globalFilters);
    }
    const incomingFavoriteProducers = incoming.preferences?.favoriteProducers;
    if (incomingFavoriteProducers) {
      changed.favoriteProducers = true;
      const favoriteById = new Map<number, FavoriteProducer>();
      if (options.mode !== 'replace') currentFavoriteProducers.forEach(producer => favoriteById.set(producer.id, producer));
      incomingFavoriteProducers.forEach(producer => favoriteById.set(producer.id, producer));
      useFavoriteProducerStore.setState({ producers: [...favoriteById.values()] });
    }
    if (options.mode === 'replace') {
      await replaceHistory(incoming.history.events);
      changed.history = true;
    } else {
      changed.history = await mergeHistory(incoming.history.events);
    }
    await useHistoryStore.getState().reloadHistory();
    return {
      before: getCountsFromSections({
        history: { events: currentHistory },
        ratings: currentRatings,
        playlists: { folders: currentFolders, playlists: currentPlaylists },
        hiddenSongs: currentHiddenSongs,
        preferences: { globalFilters: currentGlobalFilters, favoriteProducers: currentFavoriteProducers },
      }),
      after: await readCurrentBackupCounts(),
      mode: options.mode,
    };
  } catch (error) {
    const rollbackErrors: string[] = [];
    if (changed.history) {
      try {
        await restoreHistoryStoreSnapshot(currentHistorySnapshot);
        await useHistoryStore.getState().reloadHistory();
      } catch (rollbackError) {
        rollbackErrors.push(`履歴: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
      }
    }
    if (changed.favoriteProducers) {
      try { useFavoriteProducerStore.setState({ producers: currentFavoriteProducers }); }
      catch (rollbackError) { rollbackErrors.push(`お気に入りP: ${String(rollbackError)}`); }
    }
    if (changed.globalFilters) {
      try { useGlobalFilterStore.getState().setSettings(currentGlobalFilters); }
      catch (rollbackError) { rollbackErrors.push(`全体フィルター: ${String(rollbackError)}`); }
    }
    if (changed.hiddenSongs) {
      try { useHiddenSongStore.getState().replaceHiddenSongs(currentHiddenSongs); }
      catch (rollbackError) { rollbackErrors.push(`非表示曲: ${String(rollbackError)}`); }
    }
    if (changed.ratings) {
      try { useRatingStore.setState({ ratings: currentRatings }); }
      catch (rollbackError) { rollbackErrors.push(`評価: ${String(rollbackError)}`); }
    }
    if (changed.playlists) {
      try { usePlaylistStore.setState({ playlists: currentPlaylists, folders: currentFolders }); }
      catch (rollbackError) { rollbackErrors.push(`プレイリスト: ${String(rollbackError)}`); }
    }
    for (const key of [...storageSnapshot.keys()].reverse()) {
      const shouldRestore = (key === 'diva_playlists' || key === 'diva_playlistFolders')
        ? changed.playlists
        : key === 'diva-ratings' ? changed.ratings
          : key === 'diva-hidden-songs' ? changed.hiddenSongs
            : key === 'diva-global-filters' ? changed.globalFilters
              : changed.favoriteProducers;
      if (!shouldRestore || typeof localStorage === 'undefined') continue;
      try {
        const value = storageSnapshot.get(key) ?? null;
        if (value === null) localStorage.removeItem(key);
        else localStorage.setItem(key, value);
      } catch (rollbackError) {
        rollbackErrors.push(`${key}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
      }
    }
    console.error('[FullBackup] Import failed', error);
    if (rollbackErrors.length > 0) console.error('[FullBackup] Rollback incomplete', rollbackErrors);
    throw new FullBackupImportError(
      error instanceof Error ? error.message : String(error),
      rollbackErrors.length === 0,
      rollbackErrors,
    );
  }
}
