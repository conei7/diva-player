import { describe, expect, it } from 'vitest';
import { filterHistoryEntries, matchesHistoryQuery } from './historySearch';

const entries = [
  { song: { name: '夜明け', artistString: 'DIVA' }, playedAt: 2 },
  { song: { name: '星の歌', artistString: '別のP' }, playedAt: 1 },
];

describe('history search', () => {
  it('matches title and artist case-insensitively', () => {
    expect(matchesHistoryQuery(entries[0].song, 'DIVA')).toBe(true);
    expect(matchesHistoryQuery(entries[1].song, '星')).toBe(true);
    expect(matchesHistoryQuery(entries[1].song, 'missing')).toBe(false);
  });

  it('keeps the original order and returns all entries for an empty query', () => {
    expect(filterHistoryEntries(entries, '  ')).toBe(entries);
    expect(filterHistoryEntries(entries, 'P')).toEqual([entries[1]]);
  });
});
