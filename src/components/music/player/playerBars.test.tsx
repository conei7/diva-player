/**
 * Markup contracts of the music layout's player bar and phone mini bar (labels, test ids, which
 * controls are disabled). Rendered to static HTML, no DOM needed; media queries read as false there,
 * so the bar renders its narrow (640–1023px) form.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import type { ReactElement } from 'react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PV, Song } from '../../../types/vocadb';

let usePlayerStore: typeof import('../../../stores/playerStore').usePlayerStore;
let MusicPlayerBar: typeof import('../MusicPlayerBar').default;
let MusicMiniBar: typeof import('../MusicMiniBar').default;
let PlayerBarVolume: typeof import('./PlayerBarVolume').default;
const localStorageValues = new Map<string, string>();

function makeSong(id: number, service: PV['service'] = 'Youtube'): Song {
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
    pvServices: service,
    pvs: [{
      author: '',
      disabled: false,
      id,
      length: 225,
      name: 'pv',
      pvId: 'abcdefghijk',
      service,
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
  const { useLanguageStore } = await import('../../../stores/languageStore');
  Object.assign(useLanguageStore.getInitialState(), { language: 'ja' });
  MusicPlayerBar = (await import('../MusicPlayerBar')).default;
  MusicMiniBar = (await import('../MusicMiniBar')).default;
  PlayerBarVolume = (await import('./PlayerBarVolume')).default;
});

type PlayerState = ReturnType<typeof usePlayerStore.getState>;

/**
 * Server rendering reads zustand's initial state (the getServerSnapshot of useSyncExternalStore), so
 * the fixtures are written into that object as well.
 */
function setPlayer(state: Partial<PlayerState>) {
  usePlayerStore.setState(state);
  Object.assign(usePlayerStore.getInitialState(), state);
}

beforeEach(() => {
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

function render(element: ReactElement): string {
  return renderToStaticMarkup(<MemoryRouter>{element}</MemoryRouter>);
}

/** The opening tag of the element with this attribute (e.g. `aria-label="次の曲"`). */
function tag(html: string, attribute: string): string {
  const escaped = attribute.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = html.match(new RegExp(`<[a-z]+\\b[^>]*${escaped}[^>]*>`));
  if (!match) throw new Error(`No element with ${attribute}`);
  return match[0];
}

describe('MusicPlayerBar', () => {
  it('stays in place with every control disabled while no song is loaded', () => {
    const html = render(<MusicPlayerBar />);
    expect(tag(html, 'data-testid="music-player-bar"')).toMatch(/^<section[^>]*aria-label="再生バー"/);
    expect(html).toContain('曲を選ぶと、ここで操作できます');
    const buttons = html.match(/<button\b[^>]*>/g) ?? [];
    expect(buttons.length).toBeGreaterThanOrEqual(8);
    for (const button of buttons) expect(button).toContain('disabled=""');
    expect(tag(html, 'data-testid="music-play-toggle"')).toContain('aria-label="再生"');
    expect(html).not.toContain('role="slider"');
  });

  it('links the song to its page and follows the queue rules of the mini player', () => {
    play([first]);
    const html = render(<MusicPlayerBar />);
    expect(html).toContain('href="/watch?v=4242&amp;autoplay=0"');
    expect(html).toContain('Fixture song 4242');
    expect(tag(html, 'data-testid="music-play-toggle"')).not.toContain('disabled=""');
    // One song: shuffle says why it does nothing, there is no next song, 前の曲 restarts the song.
    expect(tag(html, 'aria-label="シャッフル"')).toContain('aria-disabled="true"');
    expect(tag(html, 'aria-label="次の曲"')).toContain('disabled=""');
    expect(tag(html, 'aria-label="前の曲"')).not.toContain('disabled=""');
    expect(tag(html, 'aria-label="ループ: オフ"')).toContain('aria-pressed="false"');
    expect(tag(html, 'data-testid="music-player-queue"')).toMatch(/aria-expanded="false"/);
    expect(html).toContain('aria-label="シーク"');
  });

  it('enables 次の曲 with a next song or a repeating queue', () => {
    play([first, second]);
    let html = render(<MusicPlayerBar />);
    expect(tag(html, 'aria-label="次の曲"')).not.toContain('disabled=""');
    expect(tag(html, 'aria-label="シャッフル"')).not.toContain('aria-disabled="true"');

    play([first, second], 1);
    setPlayer({ loopMode: 'all' });
    html = render(<MusicPlayerBar />);
    expect(tag(html, 'aria-label="次の曲"')).not.toContain('disabled=""');
    expect(tag(html, 'aria-label="ループ: すべて"')).toContain('aria-pressed="true"');
  });

  it('keeps 前の曲 / 次の曲 usable during a cold restore', () => {
    setPlayer({
      currentSong: first,
      currentPV: first.pvs?.[0] ?? null,
      queue: [],
      queueIndex: 0,
      queueSources: ['manual', 'manual'],
      restoringQueueWindow: { songs: [first, second], offset: 0 },
    });
    const html = render(<MusicPlayerBar />);
    expect(tag(html, 'aria-label="前の曲"')).not.toContain('disabled=""');
    expect(tag(html, 'aria-label="次の曲"')).not.toContain('disabled=""');
  });

  it('shows 一時停止 while playing and the muted state on the mute button', () => {
    play([first]);
    setPlayer({ isPlaying: true, volume: 0 });
    const html = render(<MusicPlayerBar />);
    expect(tag(html, 'data-testid="music-play-toggle"')).toContain('aria-label="一時停止"');
    expect(tag(html, 'data-testid="music-mute-toggle"')).toContain('aria-label="ミュートを解除"');
  });
});

describe('PlayerBarVolume', () => {
  it('is a labelled range bound to the volume', () => {
    play([first]);
    const html = render(<PlayerBarVolume showSlider />);
    const slider = tag(html, 'type="range"');
    expect(slider).toContain('aria-label="音量"');
    expect(slider).toContain('value="40"');
    expect(slider).not.toContain('disabled=""');
    expect(tag(html, 'data-testid="music-mute-toggle"')).toContain('aria-label="ミュート"');
  });

  it('is disabled with an explanation for Bilibili, which takes no volume from the app', () => {
    play([makeSong(5, 'Bilibili')]);
    const html = render(<PlayerBarVolume showSlider />);
    expect(tag(html, 'type="range"')).toContain('disabled=""');
    expect(tag(html, 'data-testid="music-mute-toggle"')).toContain('aria-disabled="true"');
    expect(html).toContain('Bilibiliの動画は、動画のプレイヤーで音量を変えてください');
  });
});

describe('MusicMiniBar', () => {
  it('renders nothing without a song', () => {
    expect(render(<MusicMiniBar />)).toBe('');
  });

  it('has the song label as a link and 44px play / next buttons', () => {
    play([first]);
    setPlayer({ isPlaying: true });
    const html = render(<MusicMiniBar />);
    expect(tag(html, 'data-testid="music-mini-bar"')).toContain('music-mini-bar');
    const label = tag(html, 'data-testid="music-mini-open"');
    expect(label).toContain('role="link"');
    expect(label).toContain('tabindex="0"');
    expect(tag(html, 'data-testid="music-mini-play-toggle"')).toMatch(/aria-label="一時停止"[^>]*size-11!/);
    expect(tag(html, 'aria-label="次の曲"')).toContain('size-11!');
    expect(html).toContain('Fixture song 4242');
  });
});
