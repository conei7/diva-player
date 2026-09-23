import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { translate, translateSourceText } from '../i18n';
import { ensureEnglishTranslations, resolveAppLanguage, useLanguageStore } from './languageStore';

describe('language preference', () => {
  let values: Map<string, string>;

  beforeEach(() => {
    values = new Map();
    vi.stubGlobal('localStorage', {
      get length() { return values.size; },
      clear: () => values.clear(),
      getItem: (key: string) => values.get(key) ?? null,
      key: (index: number) => [...values.keys()][index] ?? null,
      removeItem: (key: string) => values.delete(key),
      setItem: (key: string, value: string) => { values.set(key, String(value)); },
    } satisfies Storage);
    useLanguageStore.setState({ language: 'ja' });
  });

  afterEach(() => vi.unstubAllGlobals());

  it('uses a saved choice before the browser language', () => {
    expect(resolveAppLanguage('ja', ['en-US'])).toBe('ja');
    expect(resolveAppLanguage('en', ['ja-JP'])).toBe('en');
  });

  it('uses Japanese for Japanese browsers and English otherwise', () => {
    expect(resolveAppLanguage(null, ['ja-JP', 'en-US'])).toBe('ja');
    expect(resolveAppLanguage(null, ['en-US', 'en'])).toBe('en');
  });

  it('keeps the server-side default in Japanese', () => {
    expect(useLanguageStore.getState().language).toBe('ja');
  });

  it('persists the selected language without changing other local data', async () => {
    localStorage.setItem('diva_history', JSON.stringify([{ songId: 12 }]));
    await useLanguageStore.getState().setLanguage('en');

    expect(useLanguageStore.getState().language).toBe('en');
    expect(JSON.parse(localStorage.getItem('diva_uiLanguage') ?? 'null')).toBe('en');
    expect(JSON.parse(localStorage.getItem('diva_history') ?? 'null')).toEqual([{ songId: 12 }]);
  });

  it('formats translated labels with dynamic values', async () => {
    await ensureEnglishTranslations();
    expect(translate('en', 'discoveryPlaying', { count: 24 })).toBe('Playing 24 songs');
    expect(translate('ja', 'discoveryPlaying', { count: 24 })).toBe('24曲を再生中');
  });

  it('translates source copy while keeping Japanese fallback and interpolated values', async () => {
    await ensureEnglishTranslations();
    expect(translateSourceText('en', '★{rating} の曲はまだありません', { rating: 4 })).toBe('No songs rated ★4 yet');
    expect(translateSourceText('ja', '★{rating} の曲はまだありません', { rating: 4 })).toBe('★4 の曲はまだありません');
    expect(translateSourceText('en', '未登録の文字列')).toBe('未登録の文字列');
  });
});
