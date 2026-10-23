import { storage } from './storage';

export const DEFAULT_ACCENT_COLOR = '#06d6a0';
export const ACCENT_COLOR_KEY = 'accentColor';
export const THEME_MODE_KEY = 'themeMode';
export type ThemeMode = 'dark' | 'light' | 'system';
export type ResolvedThemeMode = Exclude<ThemeMode, 'system'>;
export function resolveThemeMode(mode: ThemeMode): ResolvedThemeMode {
  if (mode !== 'system') return mode;
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
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
