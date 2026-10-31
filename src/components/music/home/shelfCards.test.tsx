/**
 * Markup and play contract of the music layout's Home shelves: square artwork, a semantic song link
 * (`/watch?v=…&autoplay=0`) on every song card, ▶ that plays in place (the loaded song only pauses
 * or resumes) and labelled shelf sections.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StateCreator } from 'zustand';
import type { Playlist, Song } from '../../../types/vocadb';
import { usePlayerStore } from '../../../stores/playerStore';
import { useSelectionStore } from '../../../stores/selectionStore';
import { playShelfPlaylist, playShelfSong } from './musicHomeSources';
import ShelfPlaylistCard from './ShelfPlaylistCard';
import ShelfSongCard from './ShelfSongCard';
import SongShelf from './SongShelf';

/*
 * Static rendering reads a zustand store's server snapshot, which is its initial state. These stores
 * answer with their current state instead, so the cards render the player state set up in each test.
 */
vi.mock('zustand', async importOriginal => {
  const actual = await importOriginal<typeof import('zustand')>();
  const { useSyncExternalStore } = await import('react');
  const createWithCurrentSnapshot = (createState: StateCreator<unknown>) => {
    const api = actual.createStore<unknown>(createState);
    const useBoundStore = (selector: (state: unknown) => unknown = state => state) => useSyncExternalStore(
      api.subscribe,
      () => selector(api.getState()),
      () => selector(api.getState()),
    );
    return Object.assign(useBoundStore, api);
  };
  const create = (createState?: StateCreator<unknown>) => (
    createState ? createWithCurrentSnapshot(createState) : createWithCurrentSnapshot
  );
  return { ...actual, create };
});

const song: Song = {
  id: 4242,
  name: 'Fixture song',
  artistString: 'Fixture P feat. 初音ミク',
  artists: [
    { id: 1, name: 'Fixture P', categories: 'Producer', effectiveRoles: 'Default', isCustomName: false, isSupport: false, roles: 'Default', artist: { id: 77, name: 'Fixture P' } },
    { id: 2, name: '初音ミク', categories: 'Vocalist', effectiveRoles: 'Default', isCustomName: false, isSupport: false, roles: 'Default' },
  ],
  createDate: '2020-01-01T00:00:00Z',
  defaultName: 'Fixture song',
  defaultNameLanguage: 'Japanese',
  favoritedTimes: 0,
  lengthSeconds: 225,
  pvServices: 'Youtube',
  pvs: [{
    author: '',
    disabled: false,
    id: 1,
    length: 225,
    name: 'pv',
    pvId: 'abcdefghijk',
    service: 'Youtube',
    pvType: 'Original',
    url: 'https://youtu.be/abcdefghijk',
  }],
  ratingScore: 0,
  songType: 'Original',
  status: 'Finished',
  version: 1,
} as Song;

const initialPlayerState = usePlayerStore.getState();
const initialSelectionState = useSelectionStore.getState();

function render(element: ReactElement): string {
  // React hoists image preload <link>s in front when rendering to a string.
  return renderToStaticMarkup(<MemoryRouter>{element}</MemoryRouter>).replace(/^(?:<link [^>]*\/>)+/, '');
}

afterEach(() => {
  usePlayerStore.setState(initialPlayerState, true);
  useSelectionStore.setState(initialSelectionState, true);
});

describe('ShelfSongCard', () => {
  it('has square artwork, a ▶ over it and the song link without autoplay', () => {
    const html = render(<ul><ShelfSongCard song={song} finePointer /></ul>);
    expect(html).toMatch(/^<ul><li data-testid="music-shelf-card" class="group relative shrink-0 snap-start /);
    expect(html).toContain('aspect-square');
    expect(html).toContain('src="https://img.youtube.com/vi/abcdefghijk/mqdefault.jpg"');
    expect(html).toContain('aria-label="「Fixture song」を再生"');
    expect(html).toContain('href="/watch?v=4242&amp;autoplay=0"');
    expect(html).toContain('reveal-on-hover');
    expect(html).not.toMatch(/<a [^>]*>(?:(?!<\/a>).)*<button/);
    expect(html).not.toContain('data-now-playing');
  });

  it('shows the rank and the playing state, and offers 一時停止 for the playing song', () => {
    usePlayerStore.setState({ currentSong: song, isPlaying: true });
    const html = render(<ul><ShelfSongCard song={song} rank={3} finePointer /></ul>);
    expect(html).toContain('data-now-playing="true"');
    expect(html).toContain('aria-label="「Fixture song」を一時停止"');
    expect(html).toMatch(/tabular-nums">3<\/span>/);
  });

  it('cannot be played without a playable video', () => {
    const html = render(<ul><ShelfSongCard song={{ ...song, pvs: [] }} finePointer /></ul>);
    expect(html).toContain('再生できません');
    expect(html).toMatch(/<button type="button" aria-label="「Fixture song」を再生" disabled=""/);
  });

  it('selects instead of playing in selection mode', () => {
    useSelectionStore.setState({ isSelectionMode: true });
    const html = render(<ul><ShelfSongCard song={song} finePointer /></ul>);
    expect(html).toContain('aria-label="「Fixture song」を選択" aria-pressed="false"');
    expect(html).not.toContain('href="/watch');
  });
});

describe('ShelfPlaylistCard', () => {
  it('links to the playlist and plays it from its cover', () => {
    const playlist: Playlist = { id: 'p1', name: 'Drive', songs: [song, { ...song, id: 4243 }], createdAt: 0, updatedAt: 0 };
    const html = render(<ul><ShelfPlaylistCard playlist={playlist} finePointer /></ul>);
    expect(html).toContain('data-testid="music-shelf-playlist"');
    expect(html).toContain('href="/playlists?list=p1"');
    expect(html).toContain('aria-label="「Drive」を再生"');
    expect(html).toContain('2曲');
    expect(html).toContain('aspect-square');
  });

  it('has no ▶ for an empty playlist', () => {
    const playlist: Playlist = { id: 'p2', name: 'Empty', songs: [], createdAt: 0, updatedAt: 0 };
    expect(render(<ul><ShelfPlaylistCard playlist={playlist} finePointer={false} /></ul>)).not.toContain('を再生');
  });
});

describe('SongShelf', () => {
  it('is a section labelled by its h2 with a horizontally scrolling list', () => {
    const html = render(
      <SongShelf shelf="recent" title="最近再生した曲" seeAllTo="/history" finePointer>
        <li>card</li>
      </SongShelf>,
    );
    const labelledBy = html.match(/^<section data-testid="music-shelf" data-shelf="recent" aria-labelledby="([^"]+)"/)?.[1];
    expect(labelledBy).toBeTruthy();
    expect(html).toContain(`<h2 id="${labelledBy}"`);
    expect(html).toContain('>最近再生した曲</h2>');
    expect(html).toContain('href="/history"');
    expect(html).toContain('overflow-x-auto');
    expect(html).toContain('snap-x');
    expect(html).toContain('<ul role="list"');
  });
});

describe('shelf playback', () => {
  it('starts a new song in place with it as the mix seed', () => {
    const setRootSeed = vi.fn();
    const setQueue = vi.fn();
    usePlayerStore.setState({ currentSong: null, isPlaying: false, setRootSeed, setQueue });
    playShelfSong(song);
    expect(setRootSeed).toHaveBeenCalledWith(song);
    expect(setQueue).toHaveBeenCalledWith([song], 0, true, 'manual');
  });

  it('only pauses or resumes the song that is already loaded', () => {
    const setQueue = vi.fn();
    const pause = vi.fn();
    const resume = vi.fn();
    usePlayerStore.setState({ currentSong: song, isPlaying: true, setQueue, pause, resume });
    playShelfSong(song);
    expect(pause).toHaveBeenCalledTimes(1);
    usePlayerStore.setState({ isPlaying: false });
    playShelfSong(song);
    expect(resume).toHaveBeenCalledTimes(1);
    expect(setQueue).not.toHaveBeenCalled();
  });

  it('plays a playlist from its first song with its name as the queue title', () => {
    const setQueue = vi.fn();
    usePlayerStore.setState({ setQueue });
    const playlist: Playlist = { id: 'p1', name: 'Drive', songs: [song], createdAt: 0, updatedAt: 0 };
    playShelfPlaylist(playlist);
    playShelfPlaylist({ ...playlist, songs: [] });
    expect(setQueue).toHaveBeenCalledTimes(1);
    expect(setQueue).toHaveBeenCalledWith([song], 0, true, 'manual', 'Drive');
  });
});
