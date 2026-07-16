import type { Playlist, PlaylistFolder, Song } from '../types/vocadb';

export type PlaylistBackupFolder = {
  id: string;
  name: string;
  parentId?: string;
};

export type PlaylistBackupItem = {
  name: string;
  description?: string;
  coverArtUrl?: string;
  folderId?: string;
  smartRule?: Playlist['smartRule'];
  songs: Song[];
};

export function toSafeFileName(name: string): string {
  return name.trim().replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, '_') || 'playlist';
}

export function formatTotalDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const restSeconds = seconds % 60;

  if (hours > 0) return `${hours}時間${String(minutes).padStart(2, '0')}分`;
  if (minutes > 0) return `${minutes}分${String(restSeconds).padStart(2, '0')}秒`;
  return `${restSeconds}秒`;
}

export function downloadJson(fileName: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseImportedSong(value: unknown): Song | null {
  if (!isRecord(value) || typeof value.id !== 'number' || typeof value.name !== 'string') return null;

  const pvs = Array.isArray(value.pvs) ? value.pvs : undefined;
  const songType = typeof value.songType === 'string' ? value.songType as Song['songType'] : 'Original';
  const artistString = typeof value.artistString === 'string' ? value.artistString : '';

  return {
    artistString,
    createDate: '',
    defaultName: value.name,
    defaultNameLanguage: 'Unspecified',
    favoritedTimes: 0,
    id: value.id,
    lengthSeconds: 0,
    name: value.name,
    publishDate: typeof value.publishDate === 'string' ? value.publishDate : undefined,
    pvs: pvs as Song['pvs'],
    pvServices: '',
    ratingScore: 0,
    songType,
    status: 'Finished',
    thumbUrl: typeof value.thumbUrl === 'string' ? value.thumbUrl : undefined,
    version: 0,
  };
}

function parseSmartRule(value: unknown): Playlist['smartRule'] | undefined {
  if (!isRecord(value)) return undefined;
  const minYoutubeViews = value.minYoutubeViews;
  const minNicoViews = value.minNicoViews;
  if (typeof minYoutubeViews !== 'number' || !Number.isInteger(minYoutubeViews) || minYoutubeViews < 0) return undefined;
  if (typeof minNicoViews !== 'number' || !Number.isInteger(minNicoViews) || minNicoViews < 0) return undefined;
  const validTypes = ['Original', 'Remaster', 'Remix', 'Cover', 'Arrangement', 'Instrumental', 'Mashup', 'MusicPV', 'DramaPV', 'Other', 'Unspecified'] as const;
  const excludedSongTypes = Array.isArray(value.excludedSongTypes)
    ? value.excludedSongTypes.filter((item): item is typeof validTypes[number] => typeof item === 'string' && validTypes.includes(item as typeof validTypes[number]))
    : [];
  return {
    minYoutubeViews,
    minNicoViews,
    excludedSongTypes,
    producerId: typeof value.producerId === 'number' && Number.isInteger(value.producerId) && value.producerId > 0 ? value.producerId : undefined,
    producerName: typeof value.producerName === 'string' ? value.producerName : undefined,
  };
}

export function parsePlaylistImport(data: unknown): { name: string; description?: string; coverArtUrl?: string; songs: Song[] } | null {
  if (!isRecord(data)) return null;
  const playlist = isRecord(data.playlist) ? data.playlist : data;
  if (!isRecord(playlist) || typeof playlist.name !== 'string' || !Array.isArray(playlist.songs)) return null;

  const songs = playlist.songs.map(parseImportedSong).filter((song): song is Song => song !== null);
  if (songs.length === 0) return null;

  return {
    name: playlist.name,
    description: typeof playlist.description === 'string' ? playlist.description : undefined,
    coverArtUrl: typeof playlist.coverArtUrl === 'string' ? playlist.coverArtUrl : undefined,
    songs,
  };
}

export function parsePlaylistBackup(data: unknown): { folders: PlaylistBackupFolder[]; playlists: PlaylistBackupItem[] } | null {
  if (!isRecord(data) || !Array.isArray(data.folders) || !Array.isArray(data.playlists)) return null;

  const folders = data.folders
    .filter(isRecord)
    .filter(folder => typeof folder.id === 'string' && typeof folder.name === 'string')
    .map(folder => ({
      id: folder.id as string,
      name: folder.name as string,
      parentId: typeof folder.parentId === 'string' ? folder.parentId : undefined,
    }));

  const playlists = data.playlists
    .filter(isRecord)
    .filter(playlist => typeof playlist.name === 'string' && Array.isArray(playlist.songs))
    .map(playlist => ({
      name: playlist.name as string,
      description: typeof playlist.description === 'string' ? playlist.description : undefined,
      coverArtUrl: typeof playlist.coverArtUrl === 'string' ? playlist.coverArtUrl : undefined,
      folderId: typeof playlist.folderId === 'string' ? playlist.folderId : undefined,
      smartRule: parseSmartRule(playlist.smartRule),
      songs: (playlist.songs as unknown[]).map(parseImportedSong).filter((song): song is Song => song !== null),
    }));

  if (folders.length === 0 && playlists.length === 0) return null;
  return { folders, playlists };
}

function serializeSong(song: Song, index: number) {
  return {
    index,
    id: song.id,
    name: song.name,
    artistString: song.artistString,
    songType: song.songType,
    publishDate: song.publishDate,
    thumbUrl: song.thumbUrl,
    pvs: song.pvs,
  };
}

export function createPlaylistExportPayload(playlist: Playlist, exportedAt = new Date().toISOString()) {
  return {
    version: 1,
    exportedAt,
    playlist: {
      id: playlist.id,
      name: playlist.name,
      description: playlist.description,
      coverArtUrl: playlist.coverArtUrl,
      isPinned: playlist.isPinned,
      createdAt: playlist.createdAt,
      updatedAt: playlist.updatedAt,
      songs: playlist.songs.map(serializeSong),
    },
  };
}

export function createAllPlaylistsBackupPayload(
  folders: PlaylistFolder[],
  playlists: Playlist[],
  exportedAt = new Date().toISOString(),
) {
  return {
    version: 1,
    exportedAt,
    folders: folders.map(folder => ({
      id: folder.id,
      name: folder.name,
      parentId: folder.parentId,
      createdAt: folder.createdAt,
      updatedAt: folder.updatedAt,
    })),
    playlists: playlists.map(playlist => ({
      id: playlist.id,
      name: playlist.name,
      description: playlist.description,
      coverArtUrl: playlist.coverArtUrl,
      folderId: playlist.folderId,
      smartRule: playlist.smartRule,
      isPinned: playlist.isPinned,
      createdAt: playlist.createdAt,
      updatedAt: playlist.updatedAt,
      songs: playlist.songs.map(serializeSong),
    })),
  };
}
