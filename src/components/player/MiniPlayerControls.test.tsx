/**
 * Markup contract of the standard mini player's controls while nothing can be heard: ミュートを解除
 * sits among the controls (phone row before 再生 / 一時停止, the top row before 再生ページを開く), never on
 * the video. Rendered to static HTML, no DOM needed.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PV, Song } from '../../types/vocadb';

let usePlayerStore: typeof import('../../stores/playerStore').usePlayerStore;
let MiniPlayerControls: typeof import('./MiniPlayerControls').default;
const localStorageValues = new Map<string, string>();

function makeSong(id: number, service: PV['service'] = 'Youtube'): Song {
  return {
    id,
    name: `Fixture song ${id}`,
    artistString: 'Fixture P feat. 初音ミク',
    artists: [],
    defaultName: `Fixture song ${id}`,
    lengthSeconds: 225,
    pvs: [{ author: '', disabled: false, id, length: 225, name: 'pv', pvId: 'abcdefghijk', service, pvType: 'Original', url: '' }],
  } as unknown as Song;
}

beforeAll(async () => {
  vi.stubGlobal('localStorage', {
    get length() { return localStorageValues.size; },
    getItem: (key: string) => localStorageValues.get(key) ?? null,
    setItem: (key: string, value: string) => { localStorageValues.set(key, value); },
    removeItem: (key: string) => { localStorageValues.delete(key); },
    key: (index: number) => [...localStorageValues.keys()][index] ?? null,
  });
  ({ usePlayerStore } = await import('../../stores/playerStore'));
  const { useLanguageStore } = await import('../../stores/languageStore');
  Object.assign(useLanguageStore.getInitialState(), { language: 'ja' });
  MiniPlayerControls = (await import('./MiniPlayerControls')).default;
});

type PlayerState = ReturnType<typeof usePlayerStore.getState>;

/** Server rendering reads zustand's initial state, so the fixtures are written into it as well. */
function setPlayer(state: Partial<PlayerState>) {
  usePlayerStore.setState(state);
  Object.assign(usePlayerStore.getInitialState(), state);
}

function play(song: Song, volume: number) {
  setPlayer({
    currentSong: song,
    currentPV: song.pvs?.[0] ?? null,
    queue: [song],
    queueIndex: 0,
    queueSources: ['manual'],
    isPlaying: true,
    volume,
  });
}

beforeEach(() => {
  setPlayer({ currentSong: null, currentPV: null, queue: [], queueIndex: -1, queueSources: [], isPlaying: false, volume: 40 });
});

const swipeHandlers = { onPointerDown: () => {}, onPointerMove: () => {}, onPointerUp: () => {}, onPointerCancel: () => {} };

function render(mobile: boolean): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <MiniPlayerControls visible mobile={mobile} onOpenSongPage={() => {}} swipeHandlers={swipeHandlers} />
    </MemoryRouter>,
  );
}

/** The opening tag of the element with this attribute (e.g. `aria-label="次の曲"`). */
function tag(html: string, attribute: string): string | null {
  const escaped = attribute.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return html.match(new RegExp(`<[a-z]+\\b[^>]*${escaped}[^>]*>`))?.[0] ?? null;
}

const UNMUTE = 'data-testid="player-mute-badge"';

describe('MiniPlayerControls ミュートを解除', () => {
  it('phone row: offered before 再生 / 一時停止 while the volume is 0', () => {
    play(makeSong(5101), 0);
    const html = render(true);
    const button = tag(html, UNMUTE);
    expect(button).toContain('aria-label="ミュートを解除"');
    expect(html.indexOf(UNMUTE)).toBeLessThan(html.indexOf('data-testid="global-mini-player-toggle"'));
    // Inside the controls (the swipe surface), not over the video.
    expect(html.indexOf('data-testid="mini-player-gesture-surface"')).toBeLessThan(html.indexOf(UNMUTE));
  });

  it('desktop: offered in the top row before 再生ページを開く', () => {
    play(makeSong(5102), 0);
    const html = render(false);
    expect(tag(html, UNMUTE)).toContain('aria-label="ミュートを解除"');
    expect(html.indexOf(UNMUTE)).toBeLessThan(html.indexOf('aria-label="再生ページを開く"'));
    expect(html.indexOf('aria-label="再生ページを開く"')).toBeLessThan(html.indexOf('data-testid="global-mini-player-toggle"'));
  });

  it('is left out while the player can be heard', () => {
    play(makeSong(5103), 40);
    expect(render(true)).not.toContain(UNMUTE);
    expect(render(false)).not.toContain(UNMUTE);
  });

  it('is left out for Bilibili, which takes no volume from the app', () => {
    play(makeSong(5104, 'Bilibili'), 0);
    expect(render(true)).not.toContain(UNMUTE);
    expect(render(false)).not.toContain(UNMUTE);
  });

  it('phone row: four buttons step down to 40px only in a narrow strip, three keep 44px', () => {
    play(makeSong(5105), 0);
    const four = tag(render(true), 'data-testid="global-mini-player-toggle"');
    expect(four).toContain('size-11!');
    expect(four).toContain('@max-[11.75rem]:size-10!');
    play(makeSong(5106), 40);
    const three = tag(render(true), 'data-testid="global-mini-player-toggle"');
    expect(three).toContain('size-11!');
    expect(three).not.toContain('@max-');
  });

  it('leaves the song label to screen readers when the strip is narrow, sooner beside four buttons', () => {
    const label = 'data-testid="mini-player-swipe-origin"';
    play(makeSong(5107), 0);
    const four = tag(render(true), label);
    expect(four).toContain('@max-[16.25rem]:sr-only');
    expect(four).not.toContain('@max-[13rem]:sr-only');
    // The desktop rows keep the 13rem step: their buttons are 40px and ミュートを解除 sits in the top row.
    expect(tag(render(false), label)).toContain('@max-[13rem]:sr-only');
    play(makeSong(5108), 40);
    const three = tag(render(true), label);
    expect(three).toContain('@max-[13rem]:sr-only');
    expect(three).not.toContain('@max-[16.25rem]:sr-only');
  });
});
