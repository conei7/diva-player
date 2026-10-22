import { storage } from './storage';

export const DEFAULT_ACCENT_COLOR = '#06d6a0';
export const ACCENT_COLOR_KEY = 'accentColor';

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
export function accessibleAccentColor(value: string): string {
  const color = normalizeAccentColor(value);
  const channels = [1, 3, 5].map(start => parseInt(color.slice(start, start + 2), 16));
  const surface = luminance([40, 40, 40]);
  for (let step = 0; step <= 100; step++) {
    const mixed = channels.map(channel => Math.round(channel + (255 - channel) * step / 100));
    if ((luminance(mixed) + 0.05) / (surface + 0.05) >= 4.5) {
      return '#' + mixed.map(channel => channel.toString(16).padStart(2, '0')).join('');
    }
  }
  return '#ffffff';
}

export function readAccentColor(): string {
  return normalizeAccentColor(storage.get<unknown>(ACCENT_COLOR_KEY));
}

export function applyAccentColor(color: string): void {
  const accent = accessibleAccentColor(color);
  document.documentElement.style.setProperty('--color-brand', accent);
  document.documentElement.style.setProperty('--color-accent-cyan', accent);
}
