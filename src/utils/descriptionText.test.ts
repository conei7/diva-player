import { describe, expect, it } from 'vitest';
import { normalizeDescriptionText, shortenUrlForDisplay, tokenizeDescriptionText } from './descriptionText';

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

describe('shortenUrlForDisplay', () => {
  it('drops the protocol, www and a trailing slash', () => {
    expect(shortenUrlForDisplay('http://www.hitorie.jp/')).toBe('hitorie.jp');
    expect(shortenUrlForDisplay('https://example.com/diva-e2e')).toBe('example.com/diva-e2e');
  });

  it('ends long addresses with an ellipsis', () => {
    const shortened = shortenUrlForDisplay('https://www.asmart.jp/Form/Product/ProductDetail.aspx?shop=0&pid=12345');
    expect(shortened).toBe('asmart.jp/Form/Product/ProductD…');
    expect(shortened).toHaveLength(32);
  });
});
