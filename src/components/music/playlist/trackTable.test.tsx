/**
 * Music layout track table: column order, ARIA roles, links and the helpers. Rendered to static
 * HTML (contentPrimitives.test.tsx pattern), no DOM needed.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import type { Song } from '../../../types/vocadb';
import type { PlaylistRowActions } from '../../playlist/PlaylistSongRow';
import TrackListHeader from './TrackListHeader';
import TrackRow from './TrackRow';
import { formatTrackDuration, getTrackProducerLinks, nextTrackSortKey, trackAriaSort } from './trackTable';

const song: Song = {
  id: 4242,
  name: 'Fixture song',
  artistString: 'Fixture P feat. 初音ミク',
  artists: [
    {
      id: 1,
      name: 'Fixture P',
      artist: { additionalNames: '', artistType: 'Producer', deleted: false, id: 77, name: 'Fixture P', status: 'Finished', version: 1 },
      categories: 'Producer',
      effectiveRoles: 'Default',
      isCustomName: false,
      isSupport: false,
      roles: 'Default',
    },
    { id: 2, name: '初音ミク', categories: 'Vocalist', effectiveRoles: 'Default', isCustomName: false, isSupport: false, roles: 'Default' },
  ],
  createDate: '2020-01-01T00:00:00Z',
  publishDate: '2020-01-01T00:00:00Z',
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
};

const noop = () => {};
const actions: PlaylistRowActions = {
  play: noop,
  toggleSelect: noop,
  remove: noop,
  moveToTop: noop,
  moveToBottom: noop,
  setThumbnail: noop,
};

function render(element: ReactElement): string {
  return renderToStaticMarkup(<MemoryRouter>{element}</MemoryRouter>);
}

function columnHeaders(html: string): string[] {
  return [...html.matchAll(/role="columnheader"[^>]*>(.*?)<\/div>(?=<div role="columnheader"|<\/div><\/div>$)/g)]
    .map(match => match[1].replace(/<[^>]+>/g, ''));
}

function row(overrides: Partial<Parameters<typeof TrackRow>[0]> = {}): string {
  return render(
    <TrackRow
      song={song}
      index={3}
      position={0}
      lastIndex={5}
      playlistName="Fixture list"
      editable
      reorderable
      watchLater={false}
      active={false}
      selectionMode={false}
      selected={false}
      actions={actions}
      {...overrides}
    />,
  );
}

describe('TrackListHeader', () => {
  it('names the columns in table order', () => {
    const html = render(<TrackListHeader sortable sortKey="addedOrder" onSortChange={noop} lead="number" />);
    expect(html).toContain('data-testid="music-track-list-header"');
    expect(html).toMatch(/^<div role="rowgroup"[^>]*><div role="row" aria-rowindex="1"/);
    expect(columnHeaders(html)).toEqual(['#', 'タイトル', 'プロデューサー', '公開日', '長さ', 'その他の操作']);
  });

  it('sorts with buttons and marks the sorted column with aria-sort', () => {
    const html = render(<TrackListHeader sortable sortKey="publishDate" onSortChange={noop} lead="number" />);
    expect(html.match(/<button/g)).toHaveLength(4);
    expect(html.match(/aria-sort=/g)).toHaveLength(1);
    expect(html).toMatch(/aria-sort="descending"[^>]*><button[^>]*><span[^>]*>公開日/);
  });

  it('is plain text for lists that keep their source order', () => {
    const html = render(<TrackListHeader sortable={false} sortKey="addedOrder" onSortChange={noop} lead="number" />);
    expect(html).not.toContain('<button');
    expect(html).not.toContain('aria-sort');
  });
});

describe('TrackRow', () => {
  it('is a row of cells whose title link plays the song (href opens the song page without autoplay)', () => {
    const html = row();
    expect(html).toMatch(/^<div role="row" aria-rowindex="2" data-testid="music-track-row"/);
    expect(html.match(/role="cell"/g)).toHaveLength(6);
    expect(html).toContain('href="/watch?v=4242&amp;autoplay=0"');
    expect(html).toContain('href="/?artistId=77&amp;artistName=Fixture%20P"');
    expect(html).toContain('3:45');
    expect(html).toContain('aria-label="「Fixture song」を再生"');
    expect(html).not.toContain('data-now-playing');
  });

  it('marks the song that is playing', () => {
    const html = row({ active: true });
    expect(html).toContain('data-now-playing="true"');
    expect(html).toContain('aria-current="true"');
    expect(html).not.toContain('「Fixture song」を再生');
  });

  it('shows a checkbox instead of the number in selection mode', () => {
    const html = row({ selectionMode: true, selected: true });
    expect(html).toContain('role="checkbox" aria-checked="true"');
    expect(html).toContain('data-selected="true"');
    expect(html).not.toContain('「Fixture song」を再生');
  });
});

describe('track table helpers', () => {
  it('falls back to the playable PV length, then to nothing', () => {
    expect(formatTrackDuration({ ...song, lengthSeconds: 0 })).toBe('3:45');
    expect(formatTrackDuration({ ...song, lengthSeconds: 0, pvs: [] })).toBeNull();
  });

  it('links producers without an id to a producer search', () => {
    const saved: Song = { ...song, artists: undefined, artistString: 'Saved P feat. 初音ミク' };
    expect(getTrackProducerLinks(saved)).toEqual([{ name: 'Saved P', href: '/?q=Saved%20P&type=producer' }]);
  });

  it('sorts by a column and goes back to the manual order on a second click', () => {
    expect(nextTrackSortKey('title', 'addedOrder')).toBe('name');
    expect(nextTrackSortKey('title', 'name')).toBe('addedOrder');
    expect(nextTrackSortKey('producer', 'name')).toBe('artist');
    expect(nextTrackSortKey('number', 'publishDate')).toBe('addedOrder');
    expect(trackAriaSort('date', 'publishDate')).toBe('descending');
    expect(trackAriaSort('title', 'name')).toBe('ascending');
    expect(trackAriaSort('title', 'artist')).toBeUndefined();
  });
});
