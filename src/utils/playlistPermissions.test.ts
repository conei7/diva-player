import { describe, expect, it } from 'vitest';
import type { Playlist } from '../types/vocadb';
import { canEditPlaylistDetails, isPlaylistEditable, isSyncedPlaylist } from './playlistPermissions';

const base: Playlist = { id: 'p', name: 'p', songs: [], createdAt: 1, updatedAt: 1 };
const youtubeSync = {
  playlistId: 'PL1234567890',
  sourceUrl: 'https://www.youtube.com/playlist?list=PL1234567890',
  enabled: true,
  intervalHours: 24,
};
const nicoSync = {
  sourceKind: 'mylist' as const,
  sourceId: '1',
  sourceUrl: 'https://www.nicovideo.jp/mylist/1',
  enabled: true,
  intervalHours: 24,
};
const playlist = (patch: Partial<Playlist>): Playlist => ({ ...base, ...patch });

describe('playlist permissions', () => {
  it('lets regular playlists and 後で聴く change their songs', () => {
    expect(isPlaylistEditable(base)).toBe(true);
    expect(isPlaylistEditable(playlist({ isPinned: true }))).toBe(true);
  });

  it('keeps smart and synced song lists read-only', () => {
    expect(isPlaylistEditable(playlist({ smartRule: { minYoutubeViews: 0, minNicoViews: 0, excludedSongTypes: [] } }))).toBe(false);
    expect(isPlaylistEditable(playlist({ youtubeSync }))).toBe(false);
    expect(isPlaylistEditable(playlist({ nicoSync }))).toBe(false);
    expect(isSyncedPlaylist(playlist({ nicoSync }))).toBe(true);
  });

  it('treats a disabled sync as a regular playlist', () => {
    const disabled = playlist({ youtubeSync: { ...youtubeSync, enabled: false } });
    expect(isPlaylistEditable(disabled)).toBe(true);
    expect(isSyncedPlaylist(disabled)).toBe(false);
  });

  it('allows editing details of everything except the built-in playlists', () => {
    expect(canEditPlaylistDetails(base)).toBe(true);
    expect(canEditPlaylistDetails(playlist({ youtubeSync }))).toBe(true);
    expect(canEditPlaylistDetails(playlist({ isPinned: true }))).toBe(false);
  });
});
