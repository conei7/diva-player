/**
 * Markup contract of the music layout's 再生中 panel: GlobalPlayer lays the video over the slot with
 * CSS only (.music-docked-player = header + 48px, panel width − 24px), so the slot must come right
 * after the 48px head inside a 12px gutter, and nothing in it may need a click while the video is there.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StateCreator } from 'zustand';
import type { Song } from '../../types/vocadb';
import { usePlayerStore } from '../../stores/playerStore';
import MusicNowPlayingPanel from './MusicNowPlayingPanel';

const ownership = vi.hoisted(() => ({ state: 'none' as 'none' | 'local' | 'remote' }));

/*
 * Static rendering reads a zustand store's server snapshot, which is its initial state. These stores
 * answer with their current state instead, so the panel renders the song set up in each test.
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

vi.mock('../../services/playbackOwnership', async importOriginal => ({
  ...(await importOriginal<typeof import('../../services/playbackOwnership')>()),
  getPlaybackOwnership: () => ({
    subscribe: () => () => {},
    getState: () => ownership.state,
  }),
}));

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

function render(): string {
  // React hoists an image preload <link> in front when rendering to a string; the panel starts after it.
  return renderToStaticMarkup(<MemoryRouter><MusicNowPlayingPanel /></MemoryRouter>).replace(/^(?:<link [^>]*\/>)+/, '');
}

/** The markup of the slot element alone (it has no nested divs other than its own children). */
function slotMarkup(html: string): string {
  const start = html.indexOf('<div class="music-video-slot"');
  const end = html.indexOf('<div class="min-h-0 flex-1 overflow-y-auto');
  return html.slice(start, end);
}

describe('MusicNowPlayingPanel', () => {
  beforeEach(() => {
    ownership.state = 'none';
    usePlayerStore.setState({
      currentSong: song,
      queue: [song],
      queueIndex: 0,
      queueSources: ['manual'],
      queueTitle: 'ミックスリスト',
      isPlaying: false,
      restoringQueueWindow: null,
    });
  });

  afterEach(() => {
    usePlayerStore.setState(initialPlayerState, true);
  });

  it('is a labelled aside whose 48px head is followed directly by the slot in a 12px gutter', () => {
    const html = render();
    expect(html).toMatch(/^<aside class="music-side-panel music-now-playing" aria-label="再生中" data-testid="music-now-playing">/);
    expect(html).toMatch(
      /^<aside[^>]*><div class="flex h-\[var\(--music-panel-head,48px\)\] flex-none [^"]*">.*?<\/div><div class="flex-none px-3"><div class="music-video-slot" data-testid="music-video-slot">/,
    );
    expect(html).toContain('<h2 class="m-0 min-w-0 flex-1 truncate text-base font-bold leading-6 text-yt-text">ミックス</h2>');
    expect(html).toContain('aria-label="再生中の表示を閉じる"');
    expect(html.match(/<main[\s>]/g)).toBeNull();
    expect(html).not.toContain('role="dialog"');
  });

  it('shows the thumbnail and a play button while the video is not in this tab', () => {
    ownership.state = 'remote';
    let slot = slotMarkup(render());
    expect(slot).toContain('src="https://img.youtube.com/vi/abcdefghijk/mqdefault.jpg"');
    expect(slot).toContain('aria-label="このタブで再生"');
    expect(slot).toContain('別のタブで再生中です');

    // A restored, paused queue: nobody plays, so the button simply says 再生.
    ownership.state = 'none';
    slot = slotMarkup(render());
    expect(slot).toContain('aria-label="再生"');
    expect(slot).not.toContain('別のタブで再生中です');
  });

  it('has nothing to press in the slot while this tab plays (the video covers it)', () => {
    ownership.state = 'local';
    let slot = slotMarkup(render());
    expect(slot).not.toContain('<button');
    expect(slot).toContain('<img');

    ownership.state = 'none';
    usePlayerStore.setState({ isPlaying: true });
    slot = slotMarkup(render());
    expect(slot).not.toContain('<button');
  });

  it('leaves the thumbnail out in hidden mode', () => {
    usePlayerStore.setState({ hiddenMode: true });
    expect(slotMarkup(render())).not.toContain('<img');
  });

  it('links the title to the song page and the producer to their songs, then lists the queue', () => {
    const html = render();
    // autoplay=0: opening the page never takes the playback over from another tab.
    expect(html).toMatch(/<h2 [^>]*><a [^>]*href="\/watch\?v=4242&amp;autoplay=0"[^>]*>Fixture song<\/a><\/h2>/);
    expect(html).toMatch(/<a [^>]*href="\/\?artistId=77&amp;artistName=Fixture%20P"[^>]*>Fixture P<\/a>/);
    expect(html).toContain('aria-label="プレイリストに保存"');
    expect(html).toContain('後で聴く');
    expect(html).toContain('共有');
    expect(html).toContain('曲の詳細');
    expect(html).toContain('>次に再生</h2>');
    expect(html).toContain('最後の曲です');
  });

  it('renders nothing without a song', () => {
    usePlayerStore.setState({ currentSong: null });
    expect(render()).toBe('');
  });
});
