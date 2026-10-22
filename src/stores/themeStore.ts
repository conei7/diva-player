import { create } from 'zustand';
import { storage } from '../utils/storage';
import { ACCENT_COLOR_KEY, applyAccentColor, normalizeAccentColor, readAccentColor } from '../utils/theme';

interface ThemeState {
  accentColor: string;
  setAccentColor: (color: string) => boolean;
}

export const useThemeStore = create<ThemeState>((set) => ({
  accentColor: readAccentColor(),
  setAccentColor: (value) => {
    const accentColor = normalizeAccentColor(value);
    const saved = storage.set(ACCENT_COLOR_KEY, accentColor);
    applyAccentColor(accentColor);
    set({ accentColor });
    return saved;
  },
}));

/** Apply before React renders; other tabs and clearing storage also update the theme. */
export function initializeTheme(): void {
  applyAccentColor(useThemeStore.getState().accentColor);
  window.addEventListener('storage', event => {
    if (event.storageArea !== localStorage || (event.key !== null && event.key !== 'diva_accentColor')) return;
    const accentColor = readAccentColor();
    applyAccentColor(accentColor);
    useThemeStore.setState({ accentColor });
  });
}
