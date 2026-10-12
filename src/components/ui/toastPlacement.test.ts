import { describe, expect, it } from 'vitest';
import { computeModalToastBottom } from './toastPlacement';

describe('computeModalToastBottom', () => {
  const phone = { viewportHeight: 844, footerHeight: 0, toastHeight: 48, safeTop: 0, safeBottom: 0 };

  it('sits at the bottom edge under a centred dialog with room below', () => {
    expect(computeModalToastBottom({ ...phone, surfaceTop: 300, surfaceBottom: 544 })).toBe(8);
    expect(computeModalToastBottom({ ...phone, surfaceTop: 300, surfaceBottom: 544, safeBottom: 34 })).toBe(42);
  });

  it('sits just above a bottom sheet (menu sheet, save-to sheet)', () => {
    // Sheet from y=302 to the bottom: the toast's bottom edge 8px above the sheet's top.
    expect(computeModalToastBottom({ ...phone, surfaceTop: 302, surfaceBottom: 844 })).toBe(550);
  });

  it('keeps clear of the notch when the sheet is tall, using the footer instead', () => {
    // 90dvh sheet: 84px above it is enough without a notch, not with a 47px inset.
    expect(computeModalToastBottom({ ...phone, surfaceTop: 84, surfaceBottom: 844 })).toBe(768);
    expect(computeModalToastBottom({ ...phone, surfaceTop: 84, surfaceBottom: 844, safeTop: 47, footerHeight: 68 })).toBe(76);
  });

  it('sits above the footer of a full-screen dialog, else at the bottom edge', () => {
    expect(computeModalToastBottom({ ...phone, surfaceTop: 0, surfaceBottom: 844, footerHeight: 68 })).toBe(76);
    expect(computeModalToastBottom({ ...phone, surfaceTop: 0, surfaceBottom: 844, safeBottom: 34 })).toBe(42);
  });
});
