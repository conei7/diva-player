import { createHistoryBackup, importHistoryBackup, normalizeImportedEvent } from './historyBackup';
import type { ListeningPlayEvent } from '../stores/historyStore';
import { parsePlaylistBackup, type PlaylistBackupFolder, type PlaylistBackupItem, downloadJson } from '../utils/playlistBackup';
import { usePlaylistStore } from '../stores/playlistStore';
import { useRatingStore } from '../stores/ratingStore';
import { storage } from '../utils/storage';
import { HISTORY_STORES, openHistoryDb } from './historyDatabase';

const BACKUP_KIND = 'diva-player-full-backup';
const BACKUP_VERSION = 1;

export interface FullBackupPayload {
  kind: typeof BACKUP_KIND;
  version: typeof BACKUP_VERSION;
  exportedAt: string;
  sections: {
    history: { events: ListeningPlayEvent[] };
    ratings: Record<string, number>;
    playlists: {
      folders: PlaylistBackupFolder[];
      playlists: PlaylistBackupItem[];
    };
  };
}

export interface FullBackupPreview {
  historyCount: number;
  ratingCount: number;
  playlistCount: number;
  folderCount: number;
  invalidItems: number;
  parsed: FullBackupPayload;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export async function createFullBackup(): Promise<FullBackupPayload> {
  const { payload: historyPayload } = await createHistoryBackup();
  const ratings = useRatingStore.getState().ratings;
  const { folders, playlists } = usePlaylistStore.getState();

  const playlistBackupFolders = folders.map(f => ({
    id: f.id,
    name: f.name,
    parentId: f.parentId,
  }));

  const playlistBackupItems = playlists.map(p => ({
    name: p.name,
    description: p.description,
    coverArtUrl: p.coverArtUrl,
    folderId: p.folderId,
    songs: p.songs,
  }));

  return {
    kind: BACKUP_KIND,
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    sections: {
      history: { events: historyPayload.events },
      ratings,
      playlists: {
        folders: playlistBackupFolders,
        playlists: playlistBackupItems,
      },
    },
  };
}

export function downloadFullBackup(payload: FullBackupPayload): void {
  const date = new Date(payload.exportedAt).toISOString().split('T')[0];
  downloadJson(`diva_full_backup_${date}.json`, payload);
}

export function parseFullBackup(data: unknown): FullBackupPreview | null {
  if (!isRecord(data) || data.kind !== BACKUP_KIND || data.version !== BACKUP_VERSION || !isRecord(data.sections)) {
    return null;
  }

  let invalidItems = 0;

  // History parsing
  const rawHistory = isRecord(data.sections.history) && Array.isArray(data.sections.history.events) ? data.sections.history.events : [];
  const events = rawHistory.map(normalizeImportedEvent).filter((e): e is ListeningPlayEvent => {
    if (e === null) {
      invalidItems++;
      return false;
    }
    return true;
  });

  // Ratings parsing
  const rawRatings = isRecord(data.sections.ratings) ? data.sections.ratings : {};
  const ratings: Record<string, number> = {};
  for (const [key, value] of Object.entries(rawRatings)) {
    if (typeof value === 'number' && value >= 1 && value <= 5) {
      ratings[key] = value;
    } else {
      invalidItems++;
    }
  }

  // Playlists parsing
  const parsedPlaylists = parsePlaylistBackup(data.sections.playlists);
  const folders = parsedPlaylists?.folders ?? [];
  const playlists = parsedPlaylists?.playlists ?? [];

  const parsed: FullBackupPayload = {
    kind: BACKUP_KIND,
    version: BACKUP_VERSION,
    exportedAt: typeof data.exportedAt === 'string' ? data.exportedAt : new Date().toISOString(),
    sections: {
      history: { events },
      ratings,
      playlists: { folders, playlists },
    },
  };

  return {
    historyCount: events.length,
    ratingCount: Object.keys(ratings).length,
    playlistCount: playlists.length,
    folderCount: folders.length,
    invalidItems,
    parsed,
  };
}

export interface ImportStrategy {
  type: 'merge' | 'replace';
  ratingPriority: 'backup' | 'current';
}

function transactionToPromise(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

export async function executeFullBackupImport(preview: FullBackupPreview, strategy: ImportStrategy): Promise<void> {
  const { parsed } = preview;
  
  // Snapshot for rollback
  const rStore = useRatingStore.getState();
  const rollbackRatingsState = { ...rStore.ratings };
  
  const pStore = usePlaylistStore.getState();
  const rollbackFoldersState = [ ...pStore.folders ];
  const rollbackPlaylistsState = [ ...pStore.playlists ];

  try {
    // 1. Playlists
    if (strategy.type === 'replace') {
      const newFolders = parsed.sections.playlists.folders.map(f => ({
        id: f.id,
        name: f.name,
        parentId: f.parentId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }));
      
      const newPlaylists = parsed.sections.playlists.playlists.map(p => ({
        id: crypto.randomUUID(),
        name: p.name,
        description: p.description,
        coverArtUrl: p.coverArtUrl,
        folderId: p.folderId,
        songs: p.songs,
        isPinned: p.name === '後で聴く',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }));
      
      storage.set('playlistFolders', newFolders);
      storage.set('playlists', newPlaylists);
      pStore.loadPlaylists();
    } else {
      const existingFolders = pStore.folders;
      const existingFolderIds = new Set(existingFolders.map(f => f.id));
      const foldersToAdd = parsed.sections.playlists.folders.filter(f => !existingFolderIds.has(f.id)).map(f => ({
        id: f.id,
        name: f.name,
        parentId: f.parentId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }));
      
      const newPlaylists = parsed.sections.playlists.playlists.map(p => ({
        id: crypto.randomUUID(),
        name: p.name,
        description: p.description,
        coverArtUrl: p.coverArtUrl,
        folderId: p.folderId,
        songs: p.songs,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }));
      
      storage.set('playlistFolders', [...existingFolders, ...foldersToAdd]);
      storage.set('playlists', [...pStore.playlists, ...newPlaylists]);
      pStore.loadPlaylists();
    }

    // 2. Ratings
    let nextRatings: Record<string, number> = {};
    if (strategy.type === 'replace') {
      nextRatings = { ...parsed.sections.ratings };
    } else {
      if (strategy.ratingPriority === 'backup') {
        nextRatings = { ...rStore.ratings, ...parsed.sections.ratings };
      } else {
        nextRatings = { ...parsed.sections.ratings, ...rStore.ratings };
      }
    }
    useRatingStore.setState({ ratings: nextRatings });
    
    // 3. History
    if (strategy.type === 'replace') {
      const db = await openHistoryDb();
      const tx = db.transaction(Object.values(HISTORY_STORES), 'readwrite');
      for (const storeName of Object.values(HISTORY_STORES)) {
        tx.objectStore(storeName).clear();
      }
      await transactionToPromise(tx);
    }
    
    const historyPayloadForImport = {
      kind: 'diva-player-history',
      version: 1,
      exportedAt: parsed.exportedAt,
      events: parsed.sections.history.events,
    };
    await importHistoryBackup(historyPayloadForImport);
    
  } catch (error) {
    // Rollback
    useRatingStore.setState({ ratings: rollbackRatingsState });
    storage.set('playlistFolders', rollbackFoldersState);
    storage.set('playlists', rollbackPlaylistsState);
    usePlaylistStore.getState().loadPlaylists();
    throw error;
  }
}
