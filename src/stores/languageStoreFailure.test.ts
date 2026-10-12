import { afterEach, describe, expect, it, vi } from 'vitest';

describe('language switch failure', () => {
  afterEach(() => {
    vi.doUnmock('../i18n-en');
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('keeps the current language and offers a retry toast when English cannot be loaded', async () => {
    vi.resetModules();
    vi.doMock('../i18n-en', () => {
      throw new Error('offline');
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      get length() { return values.size; },
      clear: () => values.clear(),
      getItem: (key: string) => values.get(key) ?? null,
      key: (index: number) => [...values.keys()][index] ?? null,
      removeItem: (key: string) => values.delete(key),
      setItem: (key: string, value: string) => { values.set(key, String(value)); },
    } satisfies Storage);
    const { useLanguageStore } = await import('./languageStore');
    const { clearToasts, useToastStore } = await import('./toastStore');
    useLanguageStore.setState({ language: 'ja' });

    await useLanguageStore.getState().setLanguage('en');

    expect(useLanguageStore.getState().language).toBe('ja');
    expect(values.has('diva_uiLanguage')).toBe(false);
    const toast = useToastStore.getState().toasts[0];
    expect(toast?.message).toBe('言語を切り替えられませんでした');
    expect(toast?.action?.label).toBe('再試行');
    clearToasts();
  });
});
