import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Song } from '../types/vocadb';

const mocks = vi.hoisted(() => ({
  generateDigPlaylist: vi.fn(),
}));

vi.mock('./digPlaylist', () => ({ generateDigPlaylist: mocks.generateDigPlaylist }));

import { useHistoryStore } from '../stores/historyStore';
import { useImplicitFeedbackStore } from '../stores/implicitFeedbackStore';
import { usePlayerStore } from '../stores/playerStore';
import { usePlaylistStore } from '../stores/playlistStore';
import { useRatingStore } from '../stores/ratingStore';
import { playDiscoveryMix } from './discoveryMix';

const song = (id: number): Song => ({
  id,
  name: `曲${id}`,
  defaultName: `曲${id}`,
  defaultNameLanguage: 'Japanese',
  artistString: `P${id}`,
  createDate: '2026-01-01',
  favoritedTimes: 0,
  lengthSeconds: 120,
  pvServices: 'Youtube',
  ratingScore: 0,
  songType: 'Original',
  status: 'Finished',
  version: 1,
});

const originalSetQueue = usePlayerStore.getState().setQueue;

describe('ephemeral discovery mix playback', () => {
  beforeEach(() => {
    mocks.generateDigPlaylist.mockReset();
    useHistoryStore.setState({ entries: [] });
    usePlaylistStore.setState({ playlists: [], folders: [] });
    useRatingStore.setState({ ratings: {} });
    useImplicitFeedbackStore.setState({ feedback: {} });
  });

  afterEach(() => {
    usePlayerStore.setState({ setQueue: originalSetQueue });
  });

  it('sends generated songs directly to the player queue without creating a playlist', async () => {
    const setQueue = vi.fn();
    usePlayerStore.setState({ setQueue });
    mocks.generateDigPlaylist.mockResolvedValue({
      songs: [song(11), song(12)],
      generationSeed: 7,
      candidateCount: 20,
      knownCount: 5,
    });

    const result = await playDiscoveryMix();

    expect(result.songs.map(item => item.id)).toEqual([11, 12]);
    expect(setQueue).toHaveBeenCalledWith(result.songs, 0, true, 'discovery');
    expect(usePlaylistStore.getState().playlists).toEqual([]);
  });

  it('leaves the current queue untouched when no candidates are found', async () => {
    const setQueue = vi.fn();
    usePlayerStore.setState({ setQueue });
    mocks.generateDigPlaylist.mockResolvedValue({
      songs: [],
      generationSeed: 8,
      candidateCount: 0,
      knownCount: 5,
    });

    await playDiscoveryMix();

    expect(setQueue).not.toHaveBeenCalled();
  });
});
