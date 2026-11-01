import { describe, expect, it } from 'vitest';
import { revealChipInRow } from './chipRow';

/** A chip in a row whose visible box spans 0–300px; the chip's own box is given in row coordinates. */
function chipInRow(left: number, width: number, scrollLeft = 0) {
  const scroller = {
    scrollLeft,
    getBoundingClientRect: () => ({ left: 0, right: 300, width: 300 }),
  };
  const chip = {
    closest: (selector: string) => (selector === '.overflow-x-auto' ? scroller : null),
    getBoundingClientRect: () => ({ left: left - scroller.scrollLeft, right: left + width - scroller.scrollLeft, width }),
  };
  return { chip: chip as unknown as HTMLElement, scroller };
}

describe('revealChipInRow', () => {
  it('leaves the row alone while the chip is fully in view', () => {
    const { chip, scroller } = chipInRow(40, 80, 0);
    revealChipInRow(chip);
    expect(scroller.scrollLeft).toBe(0);
  });

  it('centres a chip scrolled out of the row, either way', () => {
    // 新着 at 500–580 with the row at its start: centred at 540 → scrollLeft 390.
    const right = chipInRow(500, 80, 0);
    revealChipInRow(right.chip);
    expect(right.scroller.scrollLeft).toBe(390);

    // ランキング at 60–140 with the row scrolled to 400: centred at 100 → scrollLeft -50 (the browser clamps it to 0).
    const left = chipInRow(60, 80, 400);
    revealChipInRow(left.chip);
    expect(left.scroller.scrollLeft).toBe(-50);
  });

  it('centres a chip that is only partly in view', () => {
    const { chip, scroller } = chipInRow(260, 80, 0);
    revealChipInRow(chip);
    expect(scroller.scrollLeft).toBe(150);
  });

  it('does nothing outside a scrolling row', () => {
    const chip = { closest: () => null, getBoundingClientRect: () => ({ left: 900, right: 980, width: 80 }) };
    expect(() => revealChipInRow(chip as unknown as HTMLElement)).not.toThrow();
  });
});
