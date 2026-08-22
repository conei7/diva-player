import { describe, expect, it, vi } from 'vitest';
import { fetchProgressivePages } from './progressivePageFetch';

describe('fetchProgressivePages', () => {
  it('stops after the first page when the filtered target is already full', async () => {
    const fetchPage = vi.fn(async (page: number) => ({ page, eligible: 40 }));
    const result = await fetchProgressivePages({
      startPage: 0,
      maxPages: 3,
      fetchPage,
      needsMore: pages => pages.reduce((total, page) => total + page.eligible, 0) < 40,
    });

    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(result.nextPage).toBe(1);
  });

  it('fetches bounded follow-up pages only while filtering leaves fewer than forty', async () => {
    const eligibleByPage = [12, 16, 18, 20];
    const fetchPage = vi.fn(async (page: number) => ({ page, eligible: eligibleByPage[page] }));
    const result = await fetchProgressivePages({
      startPage: 0,
      maxPages: 3,
      fetchPage,
      needsMore: pages => pages.reduce((total, page) => total + page.eligible, 0) < 40,
    });

    expect(fetchPage.mock.calls.map(([page]) => page)).toEqual([0, 1, 2]);
    expect(result.pages.reduce((total, page) => total + page.eligible, 0)).toBe(46);
    expect(result.nextPage).toBe(3);
  });

  it('keeps later infinite-scroll requests to one source page', async () => {
    const fetchPage = vi.fn(async (page: number) => ({ page, eligible: 0 }));
    const result = await fetchProgressivePages({
      startPage: 4,
      maxPages: 1,
      fetchPage,
      needsMore: () => true,
    });

    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(result.nextPage).toBe(5);
  });
});
