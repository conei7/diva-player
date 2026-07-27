import { describe, expect, it } from 'vitest';
import { parseServerTiming } from './performanceMetrics';

describe('parseServerTiming', () => {
  it('extracts named durations and ignores descriptive-only entries', () => {
    expect(parseServerTiming('db-open;dur=1.2, db-count;dur=18, cache;desc="hit"')).toEqual([
      { name: 'server.db-open', durationMs: 1.2 },
      { name: 'server.db-count', durationMs: 18 },
    ]);
  });

  it('returns an empty list for missing or invalid input', () => {
    expect(parseServerTiming(null)).toEqual([]);
    expect(parseServerTiming('db;dur=invalid')).toEqual([]);
  });
});
