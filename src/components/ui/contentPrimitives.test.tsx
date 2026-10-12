/**
 * Markup contracts of the list / card primitives that other areas and the e2e
 * tests rely on (DESIGN_SPEC §4.9–4.18). Rendered to static HTML, no DOM needed.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import type { Song } from '../../types/vocadb';
import { Chip, ChipBar, RemovableChip } from './Chip';
import EmptyState from './EmptyState';
import { PageHeader, PageShell } from './PageHeader';
import SelectionBar from './SelectionBar';
import { SkeletonListRow } from './Skeleton';
import SongActionsMenu from './SongActionsMenu';
import SongListRow from './SongListRow';
import SongThumbnail from './SongThumbnail';
import Switch from './Switch';
import ViewCounts from './ViewCounts';

const song: Song = {
  id: 4242,
  name: 'Fixture song',
  artistString: 'Fixture P feat. 初音ミク',
  artists: [
    { id: 1, name: 'Fixture P', categories: 'Producer', effectiveRoles: 'Default', isCustomName: false, isSupport: false, roles: 'Default' },
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
  youtubeViews: 44_700_000,
};

function render(element: ReactElement): string {
  return renderToStaticMarkup(<MemoryRouter>{element}</MemoryRouter>);
}

describe('Chip', () => {
  it('becomes a toggle (aria-pressed + data-active) only when selected is passed', () => {
    expect(render(<Chip selected>おすすめ</Chip>)).toMatch(/aria-pressed="true"[^>]*data-active="true"/);
    expect(render(<Chip selected={false}>おすすめ</Chip>)).toMatch(/aria-pressed="false"[^>]*data-active="false"/);
    const plain = render(<Chip>おすすめ</Chip>);
    expect(plain).not.toContain('aria-pressed');
    expect(plain).not.toContain('data-active');
    expect(plain).toContain('type="button"');
  });

  it('shows the count after the label', () => {
    expect(render(<Chip count={28}>★5</Chip>)).toMatch(/★5<\/span><span[^>]*>28<\/span>/);
  });

  it('labels the remove button of a removable chip', () => {
    expect(render(<RemovableChip label="ボーカル: 初音ミク" onRemove={() => {}} />))
      .toContain('aria-label="ボーカル: 初音ミクを外す"');
  });

  it('renders the chip bar as a labelled toolbar with the trailing slot outside the scroller', () => {
    const html = render(
      <ChipBar label="カテゴリ" trailing={<button type="button">選択</button>}>
        <Chip selected>すべて</Chip>
      </ChipBar>,
    );
    expect(html).toMatch(/^<div role="toolbar" aria-label="カテゴリ"/);
    expect(html.indexOf('すべて')).toBeLessThan(html.indexOf('>選択<'));
  });

  it('sticks below the selection bar too and leaves room for the focus ring', () => {
    const html = render(<ChipBar label="カテゴリ" sticky><Chip>すべて</Chip></ChipBar>);
    expect(html).toContain('top-[calc(var(--header-height,56px)_+_var(--selection-bar-height,0px))]');
    // The scroll box (overflow-x: auto also clips vertically) gets 4px of padding, offset by -4px margins.
    expect(html).toMatch(/class="-m-1 [^"]*overflow-x-auto[^"]* p-1 /);
  });
});

describe('ViewCounts', () => {
  const pv = song.pvs![0];
  it('shows both services in their colors and darkens re-upload-only ones', () => {
    const html = render(<ViewCounts song={{
      ...song,
      youtubeViews: 44_700_000,
      nicoViews: 13_780_000,
      pvs: [pv, { ...pv, id: 2, service: 'NicoNicoDouga', pvId: 'sm1', pvType: 'Reprint' }],
    }} />);
    expect(html).toContain('title="YouTube 4470万回再生"');
    expect(html).toContain('color:#ef4444');
    expect(html).toContain('title="ニコニコ 1380万回再生 転載のみ"');
    expect(html).toContain('color:#1e40af');
  });

  it('keeps the badge of a service without a known count and renders nothing without videos', () => {
    expect(render(<ViewCounts song={{ ...song, youtubeViews: undefined }} />)).toContain('title="YouTube 再生数不明"');
    expect(render(<ViewCounts song={{ ...song, youtubeViews: undefined, pvs: [] }} />)).toBe('');
  });
});

describe('SongListRow', () => {
  it('links to the song page without autoplay and keeps buttons out of the link', () => {
    const html = render(<SongListRow song={song} trailing={<SongActionsMenu song={song} />} />);
    expect(html).toContain('href="/watch?v=4242&amp;autoplay=0"');
    expect(html).not.toMatch(/<a[^>]*>(?:(?!<\/a>).)*<button/s);
    expect(html).toContain('Fixture P');
    expect(html).toContain('4470万回再生');
    expect(html).toContain('3:45');
    expect(html).toContain('aria-label="「Fixture song」のその他の操作"');
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain('reveal-on-hover');
  });

  it('marks the playing row and replaces leading with a checkbox in selection mode', () => {
    expect(render(<SongListRow song={song} active />)).toContain('aria-current="true"');
    const selecting = render(<SongListRow song={song} leading={<span>7</span>} selectionMode selected onToggleSelect={() => {}} />);
    expect(selecting).toContain('role="checkbox" aria-checked="true" aria-label="「Fixture song」を選択"');
    expect(selecting).not.toContain('<span>7</span>');
    expect(selecting).toContain('data-selected="true"');
    // One "selected" mark: the checkbox (+ row background), not also the thumbnail's ✓ and blue frame.
    expect(selecting).not.toContain('border-yt-link');
    expect(selecting).not.toContain('bg-yt-link');
  });

  it('puts a thumbnail overlay above the row link, clickable only while shown', () => {
    const html = render(
      <SongListRow song={song} thumbnailOverlay={<button type="button" aria-label="「Fixture song」を再生">▶</button>} />,
    );
    expect(html).toContain('aria-label="「Fixture song」を再生"');
    expect(html).toMatch(/aspect-video[^"]*pointer-events-none z-\[1\]/);
    expect(html).toContain('group-hover:*:pointer-events-auto');
    expect(html).not.toMatch(/<a[^>]*>(?:(?!<\/a>).)*<button/s);
    // Selection mode: no overlay (a click toggles the selection).
    expect(render(<SongListRow song={song} selectionMode thumbnailOverlay={<button type="button">▶</button>} />))
      .not.toContain('>▶<');
  });

  it('keeps a skeleton row the same geometry as the row', () => {
    const row = render(<SongListRow song={song} size="sm" />);
    const skeleton = render(<SkeletonListRow size="sm" />);
    for (const token of ['w-[120px]', 'px-2', 'py-0.5', 'sm:py-1.5', 'gap-2']) {
      expect(row).toContain(token);
      expect(skeleton).toContain(token);
    }
  });
});

describe('SongThumbnail', () => {
  it('uses the 16:9 YouTube image, the duration badge and the rank', () => {
    const html = render(<SongThumbnail song={song} rank={2} />);
    expect(html).toContain('src="https://img.youtube.com/vi/abcdefghijk/mqdefault.jpg"');
    expect(html).toContain('alt=""');
    expect(html).toContain('3:45');
    expect(html).toMatch(/>2<\/span>/);
  });

  it('falls back to the placeholder when there is no image candidate', () => {
    const html = render(<SongThumbnail song={{ ...song, pvs: [], thumbUrl: undefined, lengthSeconds: 0 }} />);
    expect(html).not.toContain('<img');
    expect(html).not.toContain('0:00');
    expect(html).toContain('<svg');
  });
});

describe('Switch', () => {
  it('is a label row around a checkbox with role="switch"', () => {
    const html = render(<Switch checked onChange={() => {}} label="おすすめの理由を表示" className="setting-row" />);
    expect(html).toMatch(/^<label class="ui-switch-row[^"]*setting-row"/);
    expect(html).toMatch(/<input[^>]*type="checkbox"[^>]*role="switch"[^>]*checked=""/);
    expect(html).toContain('おすすめの理由を表示');
  });

  it('uses the label as aria-label when it is hidden', () => {
    expect(render(<Switch checked={false} onChange={() => {}} label="元のリストと同期" labelHidden />))
      .toContain('aria-label="元のリストと同期"');
  });
});

describe('page and state primitives', () => {
  it('renders the page title as the only heading of the header (no <main>)', () => {
    const html = render(<PageShell><PageHeader title="再生履歴" meta="全 2 件" /></PageShell>);
    expect(html).toContain('<h1');
    expect(html).toContain('再生履歴');
    expect(html).not.toContain('<main');
  });

  it('gives an empty state one line and at most one action', () => {
    const html = render(<EmptyState title="表示しない曲はありません" action={{ label: '曲を探す', to: '/' }} />);
    expect(html).toContain('表示しない曲はありません');
    expect(html).toContain('href="/"');
    expect(html.match(/<p/g)).toHaveLength(1);
  });

  it('shows the selection count in the selection bar', () => {
    const html = render(<SelectionBar data-testid="selection-fab" count={2} onClose={() => {}} onSelectAll={() => {}} />);
    expect(html).toContain('data-testid="selection-fab"');
    expect(html).toContain('2曲を選択中');
    expect(html).toContain('aria-label="選択を解除"');
    expect(html).toContain('すべて選択');
  });
});
