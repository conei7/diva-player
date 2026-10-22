import { create } from 'zustand';
import { storage } from '../utils/storage';
import { ACCENT_COLOR_KEY, THEME_MODE_KEY, applyAccentColor, normalizeAccentColor, normalizeThemeMode, readAccentColor, type ThemeMode, type ThemePreferences } from '../utils/theme';

interface ThemeState {
  accentColor: string;
  mode: ThemeMode;
  setMode: (mode: ThemeMode) => boolean;
  setPreferences: (preferences: ThemePreferences) => boolean;
  setAccentColor: (color: string) => boolean;
}

export const useThemeStore = create<ThemeState>((set, get) => ({
  accentColor: readAccentColor(),
  mode: normalizeThemeMode(storage.get(THEME_MODE_KEY)),
  setMode: value => {
    const mode = normalizeThemeMode(value);
    const saved = storage.set(THEME_MODE_KEY, mode);
    applyAccentColor(get().accentColor, mode);
    set({ mode });
    return saved;
  },
  setPreferences: preferences => {
    const accentColor = normalizeAccentColor(preferences.accentColor);
    const mode = normalizeThemeMode(preferences.mode);
    const saved = storage.setMany([{ key: ACCENT_COLOR_KEY, value: accentColor }, { key: THEME_MODE_KEY, value: mode }]);
    if (!saved.success) return false;
    applyAccentColor(accentColor, mode);
    set({ accentColor, mode });
    return true;
  },
  setAccentColor: (value) => {
    const accentColor = normalizeAccentColor(value);
    const saved = storage.set(ACCENT_COLOR_KEY, accentColor);
    applyAccentColor(accentColor, get().mode);
    set({ accentColor });
    return saved;
  },
}));

/** Apply before React renders; other tabs and clearing storage also update the theme. */
export function initializeTheme(): void {
  const { accentColor, mode } = useThemeStore.getState();
  applyAccentColor(accentColor, mode);
  window.addEventListener('storage', event => {
    if (event.storageArea !== localStorage || (event.key !== null && !['diva_accentColor', 'diva_themeMode'].includes(event.key))) return;
    const accentColor = readAccentColor();
    const mode = normalizeThemeMode(storage.get(THEME_MODE_KEY));
    applyAccentColor(accentColor, mode);
    useThemeStore.setState({ accentColor, mode });
  });
}
