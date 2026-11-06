import { storage } from './storage';

export const DEFAULT_ACCENT_COLOR = '#06d6a0';
export const ACCENT_COLOR_KEY = 'accentColor';
export const THEME_MODE_KEY = 'themeMode';
export type ThemeMode = 'dark' | 'light' | 'system';
export type ResolvedThemeMode = Exclude<ThemeMode, 'system'>;
/** The device asks for the light theme (used under 'system'). */
export const PREFERS_LIGHT_MEDIA_QUERY = '(prefers-color-scheme: light)';
/** The theme on screen for a choice: under 'system', the device's. */
export function shownThemeMode(mode: ThemeMode, prefersLight: boolean): ResolvedThemeMode {
  return mode === 'system' ? (prefersLight ? 'light' : 'dark') : mode;
}
/** The other theme: the top bar's one-press switch saves it as an explicit choice (leaving 'system'). */
export function oppositeThemeMode(mode: ResolvedThemeMode): ResolvedThemeMode {
  return mode === 'dark' ? 'light' : 'dark';
}
export function resolveThemeMode(mode: ThemeMode): ResolvedThemeMode {
  return shownThemeMode(mode, typeof window !== 'undefined' && !!window.matchMedia?.(PREFERS_LIGHT_MEDIA_QUERY).matches);
}
export interface ThemePreferences { accentColor: string; mode: ThemeMode }
export function normalizeThemeMode(value: unknown): ThemeMode {
  return value === 'light' || value === 'system' ? value : 'dark';
}

export function normalizeAccentColor(value: unknown): string {
  return typeof value === 'string' && /^#[\da-f]{6}$/i.test(value)
    ? value.toLowerCase() : DEFAULT_ACCENT_COLOR;
}

function luminance(channels: number[]): number {
  return channels.reduce((total, channel, index) => {
    const srgb = channel / 255;
    return total + (srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4)
      * [0.2126, 0.7152, 0.0722][index];
  }, 0);
}

/** Keep accent text readable on the menu surface as well as darker backgrounds. */
export function accessibleAccentColor(value: string, mode: ResolvedThemeMode = 'dark'): string {
  const color = normalizeAccentColor(value);
  const channels = [1, 3, 5].map(start => parseInt(color.slice(start, start + 2), 16));
  const surface = mode === 'light' ? luminance([240, 240, 240]) : luminance([40, 40, 40]);
  for (let step = 0; step <= 100; step++) {
    const mixed = channels.map(channel => Math.round(channel + ((mode === 'light' ? 0 : 255) - channel) * step / 100));
    const foreground = luminance(mixed);
    if ((Math.max(foreground, surface) + 0.05) / (Math.min(foreground, surface) + 0.05) >= 4.5) {
      return '#' + mixed.map(channel => channel.toString(16).padStart(2, '0')).join('');
    }
  }
  return '#ffffff';
}

export function readAccentColor(): string {
  return normalizeAccentColor(storage.get<unknown>(ACCENT_COLOR_KEY));
}

export function applyAccentColor(color: string, mode: ThemeMode = 'dark'): void {
  if (typeof document === 'undefined') return;
  const resolved = resolveThemeMode(mode);
  document.documentElement.dataset.theme = resolved;
  const accent = accessibleAccentColor(color, resolved);
  document.documentElement.style.setProperty('--color-brand', accent);
  document.documentElement.style.setProperty('--color-accent-cyan', accent);
}
