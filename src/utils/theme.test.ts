import { describe, expect, it } from 'vitest';
import { accessibleAccentColor, DEFAULT_ACCENT_COLOR, normalizeAccentColor } from './theme';

describe('accent color safety and readability', () => {
  it('accepts only full hex colors from persisted or external values', () => {
    expect(normalizeAccentColor('#AABBCC')).toBe('#aabbcc');
    for (const value of [null, {}, '#fff', 'red', 'url(https://example.com)', '#06d6a0;display:none']) {
      expect(normalizeAccentColor(value)).toBe(DEFAULT_ACCENT_COLOR);
    }
  });

  it('preserves readable colors, including the existing default', () => {
    for (const color of [DEFAULT_ACCENT_COLOR, '#ffffff', '#ff8fc7', '#6dbbff']) {
      expect(accessibleAccentColor(color)).toBe(color);
    }
  });

  it('brightens dark choices enough for a 4.5:1 contrast on the menu surface', () => {
    const luminance = (hex: string) => [1, 3, 5].reduce((sum, offset, index) => {
      const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
      return sum + (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
        * [0.2126, 0.7152, 0.0722][index];
    }, 0);
    for (const color of ['#000000', '#000080', '#800000', '#282828', '#660066']) {
      expect((luminance(accessibleAccentColor(color)) + 0.05) / (luminance('#282828') + 0.05)).toBeGreaterThanOrEqual(4.5);
    }
  });
});
