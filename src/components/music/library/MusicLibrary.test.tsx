/**
 * Markup contract of the music layout's library column: one labelled <aside>, the selected
 * destination / playlist with aria-current, folders as aria-expanded groups, and no second
 * button[aria-label="設定"] (the top bar's ⚙ is the only one).
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StateCreator } from 'zustand';
import { usePlaylistStore } from '../../../stores/playlistStore';
import { useUiStore } from '../../../stores/uiStore';
import type { Playlist } from '../../../types/vocadb';
import MusicLibrary from '../MusicLibrary';
import { useLibraryFolderStore } from './libraryHooks';

const media = vi.hoisted(() => ({ wide: false }));

/*
 * Static rendering reads a zustand store's server snapshot, which is its initial state. These stores
 * answer with their current state instead, so the column renders the library set up in each test.
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

vi.mock('../../../hooks/useMediaQuery', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../hooks/useMediaQuery')>();
  return {
    ...actual,
    useMediaQuery: (query: string) => (query === actual.MUSIC_LIBRARY_FULL_MEDIA_QUERY ? media.wide : false),
  };
});

function playlist(id: string, patch: Partial<Playlist> = {}): Playlist {
  return { id, name: `List ${id}`, songs: [], createdAt: 1, updatedAt: 1, ...patch };
}

const initialPlaylistState = usePlaylistStore.getState();
const initialUiState = useUiStore.getState();
const initialFolderState = useLibraryFolderStore.getState();

function render(path: string): string {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[path]}>
      <MusicLibrary />
    </MemoryRouter>,
  );
}

describe('MusicLibrary', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    media.wide = false;
    useUiStore.setState({ sidebarExpanded: true, pendingNavigation: null });
    usePlaylistStore.setState({
      hasHydrated: true,
      playlists: [
        playlist('watch-later', { name: '後で聴く', isPinned: true }),
        playlist('in-folder', { folderId: 'f1', updatedAt: 3 }),
        playlist('loose', { updatedAt: 2 }),
        playlist('orphan', { folderId: 'deleted', updatedAt: 1 }),
      ],
      folders: [{ id: 'f1', name: 'My folder', createdAt: 1, updatedAt: 1 }],
    });
  });

  afterEach(() => {
    usePlaylistStore.setState(initialPlaylistState, true);
    useUiStore.setState(initialUiState, true);
    useLibraryFolderStore.setState(initialFolderState, true);
    vi.restoreAllMocks();
  });

  it('is one labelled column with names when wide, and marks the open playlist', () => {
    media.wide = true;
    const html = render('/playlists?list=loose');
    expect(html.match(/<aside[\s>]/g)).toHaveLength(1);
    expect(html).toMatch(/<aside class="music-side-panel music-library" aria-label="ライブラリ" data-testid="music-library">/);
    expect(html).not.toContain('<main');
    expect(html).not.toContain('role="dialog"');
    expect(html).not.toContain('aria-label="設定"');
    expect(html).toMatch(/<button type="button" class="[^"]*">.*?<span[^>]*>設定<\/span><\/button>/);
    expect(html).toMatch(/<a aria-current="page"[^>]*href="\/playlists\?list=loose"/);
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    // 後で聴く is a fixed entry, not one of the listed playlists.
    expect(html.match(/href="\/playlists\?list=watch-later"/g)).toHaveLength(1);
    expect(html).toContain('href="/playlists?list=orphan"');
    expect(html).toMatch(/<button type="button" aria-expanded="true" aria-controls="[^"]+"[^>]*>.*?My folder/);
    expect(html).toContain('プレイリスト · 0曲');
    expect(html).toContain('フォルダー · 1件');
    // Folders come before the playlists without a folder.
    expect(html.indexOf('My folder')).toBeLessThan(html.indexOf('List loose'));
  });

  it('shows covers and icons only in the rail, with the names as labels', () => {
    const html = render('/');
    expect(html).toMatch(/<a aria-current="page" aria-label="ホーム"[^>]*href="\/"/);
    expect(html).toContain('aria-label="List loose"');
    expect(html).toContain('aria-label="My folder"');
    expect(html).not.toContain('aria-label="設定"');
    expect(html).toMatch(/<span class="sr-only">設定<\/span>/);
    expect(html).not.toContain('プレイリスト · 0曲');
  });

  it('closes a folder the user collapsed and keeps its playlists out of the list', () => {
    media.wide = true;
    useLibraryFolderStore.setState({ collapsedFolderIds: ['f1'] });
    const html = render('/playlists?list=in-folder');
    expect(html).toMatch(/<button type="button" aria-expanded="false"[^>]*>/);
    expect(html).not.toContain('href="/playlists?list=in-folder"');
    expect(html).not.toContain('aria-current="page"');
  });

  it('shows a quiet placeholder before the playlists are read, and a hint when there are none', () => {
    media.wide = true;
    usePlaylistStore.setState({ hasHydrated: false });
    expect(render('/')).toContain('data-testid="music-library-loading"');
    usePlaylistStore.setState({ hasHydrated: true, playlists: [playlist('watch-later', { isPinned: true })], folders: [] });
    const html = render('/');
    expect(html).toContain('data-testid="music-library-empty"');
    expect(html).toContain('まだプレイリストはありません');
  });
});
