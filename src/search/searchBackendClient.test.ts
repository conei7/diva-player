import { describe, expect, it } from 'vitest';
import { buildSearchQuery } from './searchBackendClient';

const baseParams = {
  sort: 'FavoritedTimes' as const,
  sortOrder: 'desc' as const,
  start: 12,
  maxResults: 28,
};

describe('backend search card responses', () => {
  it('opts into compact cards without changing default search requests', () => {
    const regular = buildSearchQuery(baseParams);
    const compact = buildSearchQuery({ ...baseParams, compactCards: true });

    expect(regular.has('compact')).toBe(false);
    expect(compact.get('compact')).toBe('true');
    expect(compact.get('start')).toBe('12');
    expect(compact.get('maxResults')).toBe('28');
  });
});
