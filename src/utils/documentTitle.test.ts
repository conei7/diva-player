import { describe, expect, it } from 'vitest';
import {
  defaultDocumentTitle,
  formatDocumentTitle,
  watchLoadingDocumentTitle,
  watchUnavailableDocumentTitle,
} from './documentTitle';

describe('formatDocumentTitle', () => {
  it('uses the default title when no song is active', () => {
    expect(formatDocumentTitle(null, 'ja')).toBe(defaultDocumentTitle('ja'));
    expect(formatDocumentTitle(undefined, 'en')).toBe(defaultDocumentTitle('en'));
  });

  it('includes the song and artist for an active song', () => {
    expect(formatDocumentTitle({ name: 'ローリンガール', artistString: 'wowaka' }, 'ja'))
      .toBe('ローリンガール — wowaka | DIVA Player');
    expect(formatDocumentTitle({ name: 'ローリンガール', artistString: 'wowaka' }, 'en'))
      .toBe('ローリンガール — wowaka | DIVA Player');
  });

  it('does not leave a dangling separator when the artist is missing', () => {
    expect(formatDocumentTitle({ name: 'Instrumental', artistString: '  ' }, 'ja'))
      .toBe('Instrumental | DIVA Player');
  });

  it('names a song without a title in the display language', () => {
    expect(formatDocumentTitle({ name: ' ', artistString: '' }, 'ja')).toBe('再生中 | DIVA Player');
    expect(formatDocumentTitle({ name: ' ', artistString: 'wowaka' }, 'en')).toBe('Now playing — wowaka | DIVA Player');
  });
});

describe('fixed document titles', () => {
  it('keeps the Japanese titles (index.html and the e2e tests use the default)', () => {
    expect(defaultDocumentTitle('ja')).toBe('DIVA Player — ボカロミュージックプレイヤー');
    expect(watchLoadingDocumentTitle('ja')).toBe('曲を読み込み中 | DIVA Player');
    expect(watchUnavailableDocumentTitle('ja')).toBe('曲を読み込めませんでした | DIVA Player');
  });

  it('has English titles for the English interface', () => {
    expect(defaultDocumentTitle('en')).toBe('DIVA Player — Vocaloid music player');
    expect(watchLoadingDocumentTitle('en')).toBe('Loading song | DIVA Player');
    expect(watchUnavailableDocumentTitle('en')).toBe("Couldn't load this song | DIVA Player");
  });
});
