/**
 * The page's wiring of getHistoryLayout: the standard layout keeps its window breakpoints whatever
 * width the page measures, and only the music layout follows the measured width.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import HistoryPage from './HistoryPage';

const view = vi.hoisted(() => ({
  musicLayout: false,
  contentWidth: 0,
  queries: new Set<string>(),
}));

vi.mock('../hooks/useMusicLayout', () => ({ useIsMusicLayout: () => view.musicLayout }));
vi.mock('../hooks/useElementWidth', () => ({ useElementWidth: () => [() => undefined, view.contentWidth] }));
vi.mock('../hooks/useMediaQuery', async importOriginal => ({
  ...(await importOriginal<typeof import('../hooks/useMediaQuery')>()),
  useMediaQuery: (query: string) => view.queries.has(query),
}));

const WIDE = '(min-width: 1024px)';
const XL = '(min-width: 1280px)';

function render({ musicLayout, contentWidth, queries }: { musicLayout: boolean; contentWidth: number; queries: string[] }) {
  Object.assign(view, { musicLayout, contentWidth, queries: new Set(queries) });
  const html = renderToStaticMarkup(<MemoryRouter><HistoryPage /></MemoryRouter>);
  return {
    rail: html.includes('data-testid="history-actions"'),
    headerMenu: html.includes('data-testid="history-actions-menu"'),
    // The list is still loading here: its placeholder rows have the rows' thumbnail width.
    largeRows: html.includes('w-[246px]'),
    mediumRows: html.includes('w-[168px]'),
  };
}

afterEach(() => {
  Object.assign(view, { musicLayout: false, contentWidth: 0, queries: new Set() });
});

describe('HistoryPage layout', () => {
  it('keeps md rows beside the column in a 1024-1279px standard window, although 1080px would fit lg rows', () => {
    expect(render({ musicLayout: false, contentWidth: 1080, queries: [WIDE] }))
      .toEqual({ rail: true, headerMenu: false, largeRows: false, mediumRows: true });
    expect(render({ musicLayout: false, contentWidth: 1160, queries: [WIDE, XL] }))
      .toEqual({ rail: true, headerMenu: false, largeRows: true, mediumRows: false });
  });

  it('follows the measured width in the music layout', () => {
    // 1440px window, library with names + 再生中 panel
    expect(render({ musicLayout: true, contentWidth: 734, queries: [WIDE, XL] }))
      .toEqual({ rail: false, headerMenu: true, largeRows: true, mediumRows: false });
    expect(render({ musicLayout: true, contentWidth: 1088, queries: [WIDE, XL] }))
      .toEqual({ rail: true, headerMenu: false, largeRows: true, mediumRows: false });
  });
});
