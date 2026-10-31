/**
 * More markup contracts of the music layout's player bar: the parts it drops next to the corner video
 * of a short screen (index.css hides `data-bar-optional`), the seek line that also works on touch
 * screens, and the wide bar's 再生中 toggle. Rendered to static HTML like playerBars.test.tsx, with
 * useMediaQuery mocked so the wide (1024px and up) form renders too.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import type { ReactElement } from 'react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Song } from '../../../types/vocadb';

const media = vi.hoisted(() => ({ matches: new Set<string>() }));

vi.mock('../../../hooks/useMediaQuery', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../hooks/useMediaQuery')>()),
  useMediaQuery: (query: string) => media.matches.has(query),
}));

let usePlayerStore: typeof import('../../../stores/playerStore').usePlayerStore;
let useProgressStore: typeof import('../../../stores/progressStore').useProgressStore;
let useMusicLayoutStore: typeof import('../../../stores/musicLayoutStore').useMusicLayoutStore;
let MusicPlayerBar: typeof import('../MusicPlayerBar').default;
let ProgressLine: typeof import('../../player/ProgressLine').default;
let MUSIC_PANEL_MEDIA_QUERY: string;
const localStorageValues = new Map<string, string>();

function makeSong(id: number): Song {
  return {
    id,
    name: `Fixture song ${id}`,
    artistString: 'Fixture P feat. 初音ミク',
    artists: [
      { id: 1, name: 'Fixture P', categories: 'Producer', effectiveRoles: 'Default', isCustomName: false, isSupport: false, roles: 'Default' },
    ],
    createDate: '2020-01-01T00:00:00Z',
    defaultName: `Fixture song ${id}`,
    defaultNameLanguage: 'Japanese',
    favoritedTimes: 0,
    lengthSeconds: 225,
    pvServices: 'Youtube',
    pvs: [{
      author: '',
      disabled: false,
      id,
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
}

const first = makeSong(4242);
const second = makeSong(4343);

beforeAll(async () => {
  vi.stubGlobal('localStorage', {
    get length() { return localStorageValues.size; },
    getItem: (key: string) => localStorageValues.get(key) ?? null,
    setItem: (key: string, value: string) => { localStorageValues.set(key, value); },
    removeItem: (key: string) => { localStorageValues.delete(key); },
    key: (index: number) => [...localStorageValues.keys()][index] ?? null,
  });
  ({ usePlayerStore } = await import('../../../stores/playerStore'));
  ({ useProgressStore } = await import('../../../stores/progressStore'));
  ({ useMusicLayoutStore } = await import('../../../stores/musicLayoutStore'));
  ({ MUSIC_PANEL_MEDIA_QUERY } = await import('../../../hooks/useMediaQuery'));
  const { useLanguageStore } = await import('../../../stores/languageStore');
  Object.assign(useLanguageStore.getInitialState(), { language: 'ja' });
  MusicPlayerBar = (await import('../MusicPlayerBar')).default;
  ProgressLine = (await import('../../player/ProgressLine')).default;
});

/** Server rendering reads zustand's initial state, so the fixtures are written into it as well. */
function setStore<T>(store: { setState: (state: Partial<T>) => void; getInitialState: () => T }, state: Partial<T>) {
  store.setState(state);
  Object.assign(store.getInitialState() as object, state);
}

type PlayerState = ReturnType<typeof usePlayerStore.getState>;
const setPlayer = (state: Partial<PlayerState>) => setStore(usePlayerStore, state);

beforeEach(() => {
  media.matches.clear();
  setPlayer({
    currentSong: null,
    currentPV: null,
    isPlaying: false,
    volume: 40,
    queue: [],
    queueIndex: -1,
    queueSources: [],
    restoringQueueWindow: null,
    loopMode: 'none',
    shuffleEnabled: false,
    queueDrawerOpen: false,
  });
  setStore(useProgressStore, { progress: 30, duration: 225 });
  setStore(useMusicLayoutStore, { nowPlayingOpen: true });
});

function play(queue: Song[], index = 0) {
  setPlayer({
    currentSong: queue[index],
    currentPV: queue[index].pvs?.[0] ?? null,
    queue,
    queueIndex: index,
    queueSources: queue.map(() => 'manual' as const),
  });
}

function render(element: ReactElement, path = '/'): string {
  return renderToStaticMarkup(<MemoryRouter initialEntries={[path]}>{element}</MemoryRouter>);
}

/** The opening tag of the element with this attribute (e.g. `aria-label="次の曲"`). */
function tag(html: string, attribute: string): string {
  const escaped = attribute.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = html.match(new RegExp(`<[a-z]+\\b[^>]*${escaped}[^>]*>`));
  if (!match) throw new Error(`No element with ${attribute}`);
  return match[0];
}

describe('MusicPlayerBar next to the corner video of a short screen', () => {
  it('marks only the artwork, プレイリストに保存, shuffle, loop and the times as optional', () => {
    play([first, second]);
    const html = render(<MusicPlayerBar />);
    const optional = html.match(/<[a-z]+\b[^>]*data-bar-optional=""[^>]*>/g) ?? [];
    expect(optional).toHaveLength(6);
    expect(optional.filter(element => element.startsWith('<a ') && element.includes('aria-hidden="true"'))).toHaveLength(1);
    for (const label of ['プレイリストに保存', 'シャッフル', 'ループ: オフ']) {
      expect(tag(html, `aria-label="${label}"`)).toContain('data-bar-optional=""');
    }
    expect(optional.filter(element => element.startsWith('<span ') && element.includes('aria-hidden="true"'))).toHaveLength(2);
  });

  it('keeps the title, 前 / 再生 / 次, キュー, ミュート, ⋮ and the progress line', () => {
    play([first, second]);
    const html = render(<MusicPlayerBar />);
    for (const attribute of [
      'aria-label="前の曲"',
      'data-testid="music-play-toggle"',
      'aria-label="次の曲"',
      'data-testid="music-player-queue"',
      'data-testid="music-mute-toggle"',
      'data-testid="music-player-more"',
      'role="slider"',
    ]) {
      expect(tag(html, attribute)).not.toContain('data-bar-optional');
    }
    const titleLinks = (html.match(/<a\b[^>]*>/g) ?? []).filter(element => !element.includes('aria-hidden'));
    expect(titleLinks).toHaveLength(1);
    expect(titleLinks[0]).not.toContain('data-bar-optional');
  });
});

describe('the progress line', () => {
  it('seeks in the bar without a fine pointer, with a taller hit area on touch screens', () => {
    play([first]);
    // No media query matches here: the bar must not depend on (hover: hover) and (pointer: fine).
    const slider = tag(render(<MusicPlayerBar />), 'role="slider"');
    expect(slider).toContain('tabindex="0"');
    expect(slider).toContain('cursor-pointer');
    expect(slider).not.toContain('pointer-events-none');
    expect(slider).toContain('pointer-coarse:before:absolute');
  });

  it('stays as it was for the mini player (no touch hit area, display-only when not seekable)', () => {
    play([first]);
    const seekable = tag(render(<ProgressLine seekable />), 'role="slider"');
    expect(seekable).toContain('cursor-pointer');
    expect(seekable).not.toContain('pointer-coarse:before');
    const displayOnly = tag(render(<ProgressLine seekable={false} touchTarget />), 'role="slider"');
    expect(displayOnly).toContain('pointer-events-none');
    expect(displayOnly).not.toContain('pointer-coarse:before');
  });

  it('gives no hit area before the duration is known', () => {
    play([first]);
    setStore(useProgressStore, { progress: 0, duration: 0 });
    const slider = tag(render(<ProgressLine seekable touchTarget />), 'role="slider"');
    expect(slider).toContain('pointer-events-none');
    expect(slider).toContain('aria-disabled="true"');
    expect(slider).not.toContain('pointer-coarse:before');
  });
});

describe('the wide bar\'s 再生中 toggle', () => {
  beforeEach(() => {
    media.matches.add(MUSIC_PANEL_MEDIA_QUERY);
  });

  it('is off while no song is loaded and on with one, without touching the saved choice', () => {
    let toggle = tag(render(<MusicPlayerBar />), 'data-testid="music-now-playing-toggle"');
    expect(toggle).toContain('disabled=""');
    expect(toggle).toContain('aria-pressed="false"');
    expect(useMusicLayoutStore.getState().nowPlayingOpen).toBe(true);

    play([first]);
    toggle = tag(render(<MusicPlayerBar />), 'data-testid="music-now-playing-toggle"');
    expect(toggle).not.toContain('disabled=""');
    expect(toggle).toContain('aria-pressed="true"');
  });

  it('is off on the song page, which shows the video in the page', () => {
    play([first]);
    const toggle = tag(render(<MusicPlayerBar />, '/watch?v=4242'), 'data-testid="music-now-playing-toggle"');
    expect(toggle).toContain('disabled=""');
    expect(toggle).toContain('aria-pressed="false"');
  });

  it('is off while the panel is closed', () => {
    play([first]);
    setStore(useMusicLayoutStore, { nowPlayingOpen: false });
    const toggle = tag(render(<MusicPlayerBar />), 'data-testid="music-now-playing-toggle"');
    expect(toggle).not.toContain('disabled=""');
    expect(toggle).toContain('aria-pressed="false"');
  });
});
