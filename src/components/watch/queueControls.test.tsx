/**
 * Markup contracts of the queue header (queue drawer, song-page panel, music 再生中 panel) and the
 * song page's scrolled control row. Rendered to static HTML, no DOM needed.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import type { ReactElement } from 'react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Song } from '../../types/vocadb';
import { buildQueueView } from './queueView';

let usePlayerStore: typeof import('../../stores/playerStore').usePlayerStore;
let QueueHeader: typeof import('./PlaylistPanel').QueueHeader;
let QueueMoreMenu: typeof import('./PlaylistPanel').QueueMoreMenu;
let WatchScrolledControls: typeof import('./WatchScrolledControls').default;
const localStorageValues = new Map<string, string>();

function makeSong(id: number): Song {
  return {
    id,
    name: `Fixture song ${id}`,
    artistString: 'Fixture P feat. 初音ミク',
    artists: [
      { id: 1, name: 'Fixture P', categories: 'Producer', effectiveRoles: 'Default', isCustomName: false, isSupport: false, roles: 'Default' },
    ],
    defaultName: `Fixture song ${id}`,
    lengthSeconds: 225,
    pvs: [],
  } as unknown as Song;
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
  ({ usePlayerStore } = await import('../../stores/playerStore'));
  const { useLanguageStore } = await import('../../stores/languageStore');
  Object.assign(useLanguageStore.getInitialState(), { language: 'ja' });
  ({ QueueHeader, QueueMoreMenu } = await import('./PlaylistPanel'));
  WatchScrolledControls = (await import('./WatchScrolledControls')).default;
});

type PlayerState = ReturnType<typeof usePlayerStore.getState>;

/** Server rendering reads zustand's initial state, so the fixtures are written into it as well. */
function setPlayer(state: Partial<PlayerState>) {
  usePlayerStore.setState(state);
  Object.assign(usePlayerStore.getInitialState(), state);
}

function play(queue: Song[], index = 0, isPlaying = true) {
  setPlayer({
    currentSong: queue[index],
    queue,
    queueIndex: index,
    queueSources: queue.map(() => 'manual' as const),
    isPlaying,
  });
}

beforeEach(() => {
  setPlayer({
    currentSong: null,
    currentPV: null,
    isPlaying: false,
    queue: [],
    queueIndex: -1,
    queueSources: [],
    restoringQueueWindow: null,
    loopMode: 'none',
    shuffleEnabled: false,
  });
});

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

function header(props: { controls?: boolean; end?: ReactElement } = {}): string {
  const { queue, queueIndex, queueSources } = usePlayerStore.getState();
  const view = buildQueueView(queue, queueIndex, queueSources, 'キュー');
  return render(<QueueHeader view={view} title="キュー" {...props} />);
}

describe('QueueHeader', () => {
  it('has play/pause between previous and next, following the player', () => {
    play([first, second]);
    let html = header();
    const labels = [...html.matchAll(/<button\b[^>]*aria-label="([^"]+)"/g)].map(match => match[1]);
    expect(labels.slice(0, 3)).toEqual(['前の曲', '一時停止', '次の曲']);
    expect(tag(html, 'data-testid="queue-play-toggle"')).not.toContain('disabled=""');

    play([first, second], 0, false);
    html = header();
    expect(tag(html, 'data-testid="queue-play-toggle"')).toContain('aria-label="再生"');
  });

  it('disables play/pause without a song', () => {
    expect(tag(header(), 'data-testid="queue-play-toggle"')).toContain('disabled=""');
  });

  it('leaves the control row out with controls={false} but keeps the title and its end slot', () => {
    play([first, second]);
    const { queue, queueIndex, queueSources } = usePlayerStore.getState();
    const view = buildQueueView(queue, queueIndex, queueSources, 'キュー');
    const html = header({ controls: false, end: <QueueMoreMenu view={view} /> });
    expect(html).toContain('>キュー</h2>');
    expect(html).toContain('1 / 2');
    expect(html).toContain('aria-label="キューのその他の操作"');
    for (const label of ['前の曲', '一時停止', '次の曲', 'シャッフル', 'ループ: オフ']) {
      expect(html).not.toContain(`aria-label="${label}"`);
    }
  });
});

describe('WatchScrolledControls', () => {
  const videoColumnRef = { current: null };

  it('renders nothing without a song', () => {
    expect(render(<WatchScrolledControls videoColumnRef={videoColumnRef} />)).toBe('');
  });

  it('shows the song as the way back to the video, with 44px play/pause and next', () => {
    play([first, second]);
    const html = render(<WatchScrolledControls videoColumnRef={videoColumnRef} />);
    expect(tag(html, 'data-testid="watch-scrolled-controls"')).toMatch(/class="fixed inset-x-0 bottom-0 /);
    // The visible name starts the button's name; the hidden part says what a tap does.
    expect(html).toMatch(/<button type="button"[^>]*><span[^>]*>Fixture song 4242<\/span><span[^>]*>Fixture P<\/span><span class="sr-only">, 動画に戻る<\/span><\/button>/);
    expect(tag(html, 'aria-label="一時停止"')).toContain('size-11!');
    expect(tag(html, 'aria-label="次の曲"')).toContain('size-11!');
    expect(tag(html, 'aria-label="次の曲"')).not.toContain('disabled=""');
  });

  it('follows the queue header rule for next: off on the last song unless the queue loops', () => {
    play([first, second], 1, false);
    let html = render(<WatchScrolledControls videoColumnRef={videoColumnRef} />);
    expect(tag(html, 'aria-label="再生"')).toContain('size-11!');
    // Soft-disabled (aria-disabled), so a focused button keeps focus.
    expect(tag(html, 'aria-label="次の曲"')).toContain('aria-disabled="true"');
    expect(tag(html, 'aria-label="次の曲"')).not.toContain('disabled=""');

    setPlayer({ loopMode: 'all' });
    html = render(<WatchScrolledControls videoColumnRef={videoColumnRef} />);
    expect(tag(html, 'aria-label="次の曲"')).not.toContain('aria-disabled="');
  });
});
