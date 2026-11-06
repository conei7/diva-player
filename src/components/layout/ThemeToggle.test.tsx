/**
 * Markup contract of the top bar's ☀/☾ theme switch: it names and shows where a press goes (the other
 * theme from the one on screen, which under 端末の設定に合わせる is the device's). Rendered to static
 * HTML with the light-scheme media query stubbed.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PREFERS_LIGHT_MEDIA_QUERY } from '../../utils/theme';
import type { ThemeMode } from '../../utils/theme';

const view = vi.hoisted(() => ({ matches: new Set<string>() }));

vi.mock('../../hooks/useMediaQuery', async importOriginal => ({
  ...await importOriginal<typeof import('../../hooks/useMediaQuery')>(),
  useMediaQuery: (query: string) => view.matches.has(query),
}));

let ThemeToggle: typeof import('./ThemeToggle').default;
let setThemeMode: (mode: ThemeMode) => void;
const localStorageValues = new Map<string, string>();

beforeAll(async () => {
  vi.stubGlobal('localStorage', {
    get length() { return localStorageValues.size; },
    getItem: (key: string) => localStorageValues.get(key) ?? null,
    setItem: (key: string, value: string) => { localStorageValues.set(key, value); },
    removeItem: (key: string) => { localStorageValues.delete(key); },
    key: (index: number) => [...localStorageValues.keys()][index] ?? null,
  });
  const { useLanguageStore } = await import('../../stores/languageStore');
  Object.assign(useLanguageStore.getInitialState(), { language: 'ja' });
  const { useThemeStore } = await import('../../stores/themeStore');
  // Static rendering reads the store's initial state (the server snapshot).
  setThemeMode = mode => { Object.assign(useThemeStore.getInitialState(), { mode }); };
  ThemeToggle = (await import('./ThemeToggle')).default;
});

beforeEach(() => {
  view.matches = new Set();
});

/** The opening tag of the switch. */
function toggleButton(): string {
  const html = renderToStaticMarkup(<ThemeToggle />);
  const button = html.match(/<button\b[^>]*data-testid="topnav-theme-toggle"[^>]*>/)?.[0];
  expect(button).toBeDefined();
  return button!;
}

describe('ThemeToggle', () => {
  it('on the dark theme it offers the light one, and on the light theme the dark one', () => {
    setThemeMode('dark');
    expect(toggleButton()).toContain('aria-label="ライトモードに切り替え"');
    expect(toggleButton()).toContain('data-theme-target="light"');
    setThemeMode('light');
    expect(toggleButton()).toContain('aria-label="ダークモードに切り替え"');
    expect(toggleButton()).toContain('data-theme-target="dark"');
  });

  it('under 端末の設定に合わせる it offers the theme the device is not showing', () => {
    setThemeMode('system');
    expect(toggleButton()).toContain('data-theme-target="light"');
    view.matches = new Set([PREFERS_LIGHT_MEDIA_QUERY]);
    expect(toggleButton()).toContain('data-theme-target="dark"');
  });

  it('a saved dark or light choice ignores the device', () => {
    view.matches = new Set([PREFERS_LIGHT_MEDIA_QUERY]);
    setThemeMode('dark');
    expect(toggleButton()).toContain('data-theme-target="light"');
  });
});
