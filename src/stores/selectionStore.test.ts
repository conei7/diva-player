import { beforeEach, describe, expect, it } from 'vitest';
import type { Song } from '../types/vocadb';
import { useSelectionStore } from './selectionStore';

function song(id: number, name: string): Song {
  return { id, name } as Song;
}

describe('selectionStore', () => {
  beforeEach(() => {
    useSelectionStore.setState({
      isSelectionMode: false,
      selectedSongIds: new Set<number>(),
      selectedSongs: new Map<number, Song>(),
      visibleSongs: [],
    });
  });

  it('keeps selected song objects when the visible list changes', () => {
    const first = song(1, 'first');
    const second = song(2, 'second');

    useSelectionStore.getState().setVisibleSongs([first]);
    useSelectionStore.getState().toggleSong(first);
    useSelectionStore.getState().setVisibleSongs([second]);

    expect([...useSelectionStore.getState().selectedSongs.values()]).toEqual([first]);
    expect(useSelectionStore.getState().selectedSongIds).toEqual(new Set([1]));
  });

  it('clears song ids and song objects together', () => {
    const selected = song(1, 'selected');
    useSelectionStore.getState().toggleSong(selected);

    useSelectionStore.getState().clearSelection();

    expect(useSelectionStore.getState().selectedSongIds.size).toBe(0);
    expect(useSelectionStore.getState().selectedSongs.size).toBe(0);
  });
});
