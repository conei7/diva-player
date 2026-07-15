import { describe, expect, it } from 'vitest';
import { formatJapaneseViews } from './formatViews';

describe('formatJapaneseViews', () => {
  it.each([
    [9_999, '9,999'],
    [10_000, '1万'],
    [99_999_999, '10000万'],
    [100_000_000, '1億'],
  ])('formats %s at the unit boundary', (value, expected) => {
    expect(formatJapaneseViews(value)).toBe(expected);
  });

  it('uses a fallback for missing card values and keeps zero for charts', () => {
    expect(formatJapaneseViews(0)).toBe('-');
    expect(formatJapaneseViews(0, { zeroIsMissing: false })).toBe('0');
    expect(formatJapaneseViews(null, { fallback: 'N/A' })).toBe('N/A');
  });
});
