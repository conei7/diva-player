/**
 * Markup contract of the frame's skip buttons (WCAG 2.4.1): hidden until focused, plain buttons (a
 * #fragment link would add a history entry), and the player one only while a song is loaded.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StateCreator } from 'zustand';
import { usePlayerStore } from '../../stores/playerStore';
import type { Song } from '../../types/vocadb';
import SkipLinks from './SkipLinks';

/*
 * Static rendering reads a zustand store's server snapshot, which is its initial state. These stores
 * answer with their current state instead, so the buttons follow the song set up in each test.
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

const initialPlayerState = usePlayerStore.getState();

function buttons(): string[] {
  return renderToStaticMarkup(<SkipLinks />).match(/<button [^>]*>[^<]*<\/button>/g) ?? [];
}

describe('SkipLinks', () => {
  afterEach(() => {
    usePlayerStore.setState(initialPlayerState, true);
  });

  it('offers only the jump to the page while nothing is loaded', () => {
    usePlayerStore.setState({ currentSong: null });
    const html = buttons();
    expect(html).toHaveLength(1);
    expect(html[0]).toMatch(/>メインコンテンツへ移動<\/button>$/);
  });

  it('adds the jump to the player while a song is loaded', () => {
    usePlayerStore.setState({ currentSong: { id: 4242, name: 'Fixture song' } as Song });
    const html = buttons();
    expect(html.map(button => button.replace(/^.*>([^<]*)<\/button>$/, '$1'))).toEqual(['メインコンテンツへ移動', 'プレイヤーへ移動']);
  });

  it('renders buttons that stay visually hidden until focused', () => {
    usePlayerStore.setState({ currentSong: { id: 4242, name: 'Fixture song' } as Song });
    for (const button of buttons()) {
      expect(button).toContain('type="button"');
      expect(button).not.toContain('href=');
      expect(button).toMatch(/class="sr-only [^"]*focus:not-sr-only focus:fixed [^"]*focus:px-4 focus:py-2"/);
    }
  });
});
