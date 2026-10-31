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

const media = vi.hoisted(() => ({ wide: false, captions: false }));

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
  const { RAIL_CAPTION_MEDIA_QUERY } = await import('./libraryModel');
  return {
    ...actual,
    useMediaQuery: (query: string) => {
      if (query === actual.MUSIC_LIBRARY_FULL_MEDIA_QUERY) return media.wide;
      if (query === RAIL_CAPTION_MEDIA_QUERY) return media.captions;
      return false;
    },
  };
});

function playlist(id: string, patch: Partial<Playlist> = {}): Playlist {
  return { id, name: `List ${id}`, songs: [], createdAt: 1, updatedAt: 1, ...patch };
}

const initialPlaylistState = usePlaylistStore.getState();
const initialUiState = useUiStore.getState();
const initialFolderState = useLibraryFolderStore.getState();

/** The opening tag of the first element that has `attribute` (e.g. 'href="/history"'). */
function tagWith(html: string, attribute: string): string {
  const end = html.indexOf(attribute);
  expect(end).toBeGreaterThan(-1);
  const start = html.lastIndexOf('<', end);
  return html.slice(start, html.indexOf('>', end) + 1);
}

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
    media.captions = false;
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
    // 「＋ プレイリストを作成」 opens the new-playlist dialog here (it used to only open /playlists).
    const empty = html.slice(html.indexOf('data-testid="music-library-empty"'));
    expect(empty).toMatch(/^[^<]*<p[^>]*>まだプレイリストはありません<\/p><button type="button" aria-haspopup="dialog"[^>]*>.*?プレイリストを作成<\/button>/);
    expect(html.match(/aria-haspopup="dialog"/g)).toHaveLength(2);
    // The rail's empty state is the ＋ tile itself.
    media.wide = false;
    expect(render('/')).toMatch(/<button type="button" aria-label="プレイリストを作成" aria-haspopup="dialog" data-testid="music-library-empty"/);
  });

  it('can create a playlist once there are playlists: ＋ in the heading, or as the last tile of the rail', () => {
    media.wide = true;
    const full = render('/');
    expect(full).not.toContain('data-testid="music-library-empty"');
    expect(full).toMatch(/<button type="button" aria-label="プレイリストを作成" aria-haspopup="dialog"[^>]*>/);
    // Before the プレイリスト一覧 link, in the heading row.
    expect(full.indexOf('aria-label="プレイリストを作成"')).toBeLessThan(full.indexOf('aria-label="プレイリスト一覧"'));
    expect(full).not.toContain('role="dialog"');

    media.wide = false;
    const rail = render('/');
    expect(rail.match(/aria-label="プレイリストを作成"/g)).toHaveLength(1);
    expect(tagWith(rail, 'aria-label="プレイリストを作成"')).toMatch(/^<button type="button"[^>]*aria-haspopup="dialog"/);
    expect(rail.indexOf('aria-label="プレイリストを作成"')).toBeGreaterThan(rail.indexOf('aria-label="List orphan"'));
  });

  it('keeps the fixed entries in 48px rows and the playlists in 56px cover rows', () => {
    for (const wide of [true, false]) {
      media.wide = wide;
      const html = render('/');
      expect(tagWith(html, 'href="/history"')).toMatch(/class="[^"]*\bh-12\b/);
      expect(tagWith(html, 'href="/playlists?list=loose"')).toMatch(/class="[^"]*\bh-14\b/);
    }
  });

  it('names the top destinations under their icons in the rail of a touch tablet', () => {
    media.captions = true;
    const rail = render('/');
    // The caption is visual only: the link's accessible name stays its aria-label.
    expect(rail).toMatch(/<a aria-label="サビ発掘"[^>]*class="[^"]*flex-col[^"]*"[^>]*><svg[^>]*>.*?<\/svg><span aria-hidden="true" class="[^"]*text-\[10px\][^"]*">サビ発掘<\/span><\/a>/);
    expect(rail).toMatch(/<span aria-hidden="true" class="[^"]*">曲調マップ<\/span>/);
    // 64px rows (not the rail's 56px), so 発掘ミックス fits without 「…」.
    expect(rail).toContain('<nav aria-label="メイン" class="shrink-0 px-1 py-2">');
    expect(rail).toContain('[&amp;&gt;button]:px-0 ');
    // 発掘ミックス keeps its visible label (no sr-only in the caption variant).
    expect(rail).not.toContain('[&amp;&gt;button&gt;span]:sr-only');

    media.wide = true;
    const full = render('/');
    expect(full).not.toMatch(/<span aria-hidden="true" class="[^"]*text-\[10px\]/);
    media.wide = false;
    media.captions = false;
    expect(render('/')).toContain('[&amp;&gt;button&gt;span]:sr-only');
  });
});
