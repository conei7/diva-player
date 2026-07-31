import { describe, expect, it } from 'vitest';
import { DEFAULT_DOCUMENT_TITLE, formatDocumentTitle } from './documentTitle';

describe('formatDocumentTitle', () => {
  it('uses the default title when no song is active', () => {
    expect(formatDocumentTitle(null)).toBe(DEFAULT_DOCUMENT_TITLE);
  });

  it('includes the song and artist for an active song', () => {
    expect(formatDocumentTitle({ name: 'ローリンガール', artistString: 'wowaka' }))
      .toBe('ローリンガール — wowaka | DIVA Player');
  });

  it('does not leave a dangling separator when the artist is missing', () => {
    expect(formatDocumentTitle({ name: 'Instrumental', artistString: '  ' }))
      .toBe('Instrumental | DIVA Player');
  });
});
