import { describe, expect, it } from 'vitest';
import { normalizeDescriptionText, tokenizeDescriptionText } from './descriptionText';

describe('description text rendering helpers', () => {
  it('normalizes platform line endings and escaped newlines', () => {
    expect(normalizeDescriptionText('one\\ntwo\r\nthree')).toBe('one\ntwo\nthree');
  });

  it('separates URLs from surrounding text', () => {
    expect(tokenizeDescriptionText('説明 https://example.com/path。\n続き')).toEqual([
      { type: 'text', value: '説明 ' },
      { type: 'url', value: 'https://example.com/path' },
      { type: 'text', value: '。\n続き' },
    ]);
  });

  it('keeps plain text unchanged when there are no URLs', () => {
    expect(tokenizeDescriptionText('説明\n本文')).toEqual([
      { type: 'text', value: '説明\n本文' },
    ]);
  });
});
