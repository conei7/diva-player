import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { translate, translateSourceText } from '../i18n';
import { ensureEnglishTranslations, restoreLanguage, resolveAppLanguage, useLanguageStore } from './languageStore';

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

  it('keeps the live language and stored value when restoring cannot persist', async () => {
    localStorage.setItem('diva_uiLanguage', JSON.stringify('ja'));
    const original = localStorage.setItem;
    localStorage.setItem = () => { throw new DOMException('quota', 'QuotaExceededError'); };
    await expect(restoreLanguage('en')).rejects.toThrow('Could not save language');
    expect(useLanguageStore.getState().language).toBe('ja');
    expect(localStorage.getItem('diva_uiLanguage')).toBe(JSON.stringify('ja'));
    localStorage.setItem = original;
    await restoreLanguage('en');
    expect(useLanguageStore.getState().language).toBe('en');
  });

  it('formats translated labels with dynamic values', async () => {
    await ensureEnglishTranslations();
    expect(translate('en', 'discoveryPlaying', { count: 24 })).toBe('Playing 24 songs');
    expect(translate('ja', 'discoveryPlaying', { count: 24 })).toBe('24曲を再生中');
  });

  it('translates source copy while keeping Japanese fallback and interpolated values', async () => {
    await ensureEnglishTranslations();
    expect(translateSourceText('en', '★{rating}の曲はありません', { rating: 4 })).toBe('No ★4 songs');
    expect(translateSourceText('ja', '★{rating}の曲はありません', { rating: 4 })).toBe('★4の曲はありません');
    expect(translateSourceText('en', '未登録の文字列')).toBe('未登録の文字列');
  });

  it('translates dynamic recommendation and data-status labels', async () => {
    await ensureEnglishTranslations();
    expect(translateSourceText('en', '音響的に近いおすすめ')).toBe('Recommended for its audio similarity');
    expect(translateSourceText('en', '音が近い')).toBe('Similar sound');
    expect(translateSourceText('en', '再生できない動画')).toBe('Unplayable video');
    expect(translateSourceText('en', 'その他のまだ知らない曲')).toBe('Other undiscovered songs');
    expect(translateSourceText('en', 'ニコニコ')).toBe('Niconico');
  });
});
