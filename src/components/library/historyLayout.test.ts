import { describe, expect, it } from 'vitest';
import { getHistoryLayout } from './historyLayout';

// Content widths: window − guide / library − 再生中 panel − page padding (PageShell).
const desktop = { wideViewport: true, xlViewport: false, mobile: false };
const desktopXl = { wideViewport: true, xlViewport: true, mobile: false };
const tablet = { wideViewport: false, xlViewport: false, mobile: false };
const phone = { wideViewport: false, xlViewport: false, mobile: true };
const standard = { musicLayout: false };
const music = { musicLayout: true };

describe('history page layout', () => {
  it('uses the window until the page is measured', () => {
    expect(getHistoryLayout({ contentWidth: 0, ...music, ...desktop })).toEqual({ rail: true, rowSize: 'md' });
    expect(getHistoryLayout({ contentWidth: 0, ...music, ...desktopXl })).toEqual({ rail: true, rowSize: 'lg' });
    expect(getHistoryLayout({ contentWidth: 0, ...music, ...tablet })).toEqual({ rail: false, rowSize: 'lg' });
    expect(getHistoryLayout({ contentWidth: 0, ...music, ...phone })).toEqual({ rail: false, rowSize: 'md' });
  });

  it('keeps the standard layout on its window breakpoints, whatever the width', () => {
    // 1024px and 1200px with the mini guide: md rows up to 1279px, although 1080px would fit lg rows
    expect(getHistoryLayout({ contentWidth: 904, ...standard, ...desktop })).toEqual({ rail: true, rowSize: 'md' });
    expect(getHistoryLayout({ contentWidth: 1080, ...standard, ...desktop })).toEqual({ rail: true, rowSize: 'md' });
    expect(getHistoryLayout({ contentWidth: 1159, ...standard, ...desktop })).toEqual({ rail: true, rowSize: 'md' });
    // 1280px with the mini guide, 1440px with the expanded guide
    expect(getHistoryLayout({ contentWidth: 1160, ...standard, ...desktopXl })).toEqual({ rail: true, rowSize: 'lg' });
    expect(getHistoryLayout({ contentWidth: 1152, ...standard, ...desktopXl })).toEqual({ rail: true, rowSize: 'lg' });
    // Below 1024px: lg rows without the column, md rows on phones
    expect(getHistoryLayout({ contentWidth: 536, ...standard, ...tablet })).toEqual({ rail: false, rowSize: 'lg' });
    expect(getHistoryLayout({ contentWidth: 366, ...standard, ...phone })).toEqual({ rail: false, rowSize: 'md' });
  });

  it('drops the column when the music layout leaves too little room', () => {
    // 1440px, library with names + 再生中 panel
    expect(getHistoryLayout({ contentWidth: 734, ...music, ...desktopXl })).toEqual({ rail: false, rowSize: 'lg' });
    // 1024px, library icons + 再生中 panel
    expect(getHistoryLayout({ contentWidth: 532, ...music, ...desktop })).toEqual({ rail: false, rowSize: 'md' });
    // 1920px with the panel, or 1440px with it closed: room for the column again
    expect(getHistoryLayout({ contentWidth: 1140, ...music, ...desktopXl })).toEqual({ rail: true, rowSize: 'lg' });
    expect(getHistoryLayout({ contentWidth: 1088, ...music, ...desktopXl })).toEqual({ rail: true, rowSize: 'lg' });
  });

  it('switches the music layout at 860px (column) and a 640px list (lg rows)', () => {
    expect(getHistoryLayout({ contentWidth: 860, ...music, ...desktop })).toEqual({ rail: true, rowSize: 'md' });
    expect(getHistoryLayout({ contentWidth: 859, ...music, ...desktop })).toEqual({ rail: false, rowSize: 'lg' });
    // 944px − the 280px column and its gap = 640px
    expect(getHistoryLayout({ contentWidth: 944, ...music, ...desktop })).toEqual({ rail: true, rowSize: 'lg' });
    expect(getHistoryLayout({ contentWidth: 943, ...music, ...desktop })).toEqual({ rail: true, rowSize: 'md' });
  });

  it('never shows the column below 1024px, and keeps rows readable on narrow pages', () => {
    expect(getHistoryLayout({ contentWidth: 896, ...music, ...tablet })).toEqual({ rail: false, rowSize: 'lg' });
    expect(getHistoryLayout({ contentWidth: 536, ...music, ...tablet })).toEqual({ rail: false, rowSize: 'md' });
    expect(getHistoryLayout({ contentWidth: 366, ...music, ...phone })).toEqual({ rail: false, rowSize: 'md' });
  });
});
