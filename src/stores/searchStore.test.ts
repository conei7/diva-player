import { describe, expect, it } from 'vitest';
import {
  ADVANCED_SEARCH_LIMITS,
  DEFAULT_ADVANCED_FILTERS,
  sanitizeAdvancedIntegerInput,
  validateAdvancedSearchFilters,
} from './searchStore';

describe('advanced search input limits', () => {
  it('rejects values outside the database-safe ranges', () => {
    expect(validateAdvancedSearchFilters({
      ...DEFAULT_ADVANCED_FILTERS,
      publishYearFrom: '0',
    })).toContain('投稿年');
    expect(validateAdvancedSearchFilters({
      ...DEFAULT_ADVANCED_FILTERS,
      publishYearTo: '5874897',
    })).toContain('投稿年');
    expect(validateAdvancedSearchFilters({
      ...DEFAULT_ADVANCED_FILTERS,
      lengthMinSeconds: '-1',
    })).toContain('曲の長さ');
    expect(validateAdvancedSearchFilters({
      ...DEFAULT_ADVANCED_FILTERS,
      lengthMaxSeconds: '2147483648',
    })).toContain('曲の長さ');
  });

  it('accepts the inclusive boundary values', () => {
    expect(validateAdvancedSearchFilters({
      ...DEFAULT_ADVANCED_FILTERS,
      publishYearFrom: String(ADVANCED_SEARCH_LIMITS.publishYearMin),
      publishYearTo: String(ADVANCED_SEARCH_LIMITS.publishYearMax),
      lengthMinSeconds: String(ADVANCED_SEARCH_LIMITS.lengthMinSeconds),
      lengthMaxSeconds: String(ADVANCED_SEARCH_LIMITS.lengthMaxSeconds),
    })).toBeNull();
  });

  it('clears negative input and caps oversized input before it reaches the API', () => {
    expect(sanitizeAdvancedIntegerInput('-10', 0, 100)).toBe('');
    expect(sanitizeAdvancedIntegerInput('101', 0, 100)).toBe('100');
    expect(sanitizeAdvancedIntegerInput('', 0, 100)).toBe('');
  });
});
