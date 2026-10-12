import { describe, expect, it } from 'vitest';
import { computeAnchoredPosition, computeTooltipPosition, transformOriginFor } from './overlay';
import type { RectLike } from './overlay';

const viewport = { width: 1000, height: 800 };

function rect(left: number, top: number, width: number, height: number): RectLike {
  return { left, top, width, height, right: left + width, bottom: top + height };
}

describe('computeAnchoredPosition', () => {
  const menu = { width: 240, height: 200 };

  it('opens below the anchor, aligned to its start edge', () => {
    expect(computeAnchoredPosition(rect(100, 50, 40, 40), menu, viewport, 'bottom-start', 4))
      .toEqual({ top: 94, left: 100, side: 'bottom' });
  });

  it('aligns the end edges for bottom-end', () => {
    expect(computeAnchoredPosition(rect(500, 50, 40, 40), menu, viewport, 'bottom-end', 4))
      .toEqual({ top: 94, left: 300, side: 'bottom' });
  });

  it('flips above when there is no room below', () => {
    expect(computeAnchoredPosition(rect(100, 700, 40, 40), menu, viewport, 'bottom-start', 4))
      .toEqual({ top: 496, left: 100, side: 'top' });
  });

  it('prefers above for top placements and falls back below', () => {
    expect(computeAnchoredPosition(rect(100, 400, 40, 40), menu, viewport, 'top-start', 4).side).toBe('top');
    expect(computeAnchoredPosition(rect(100, 20, 40, 40), menu, viewport, 'top-start', 4).side).toBe('bottom');
  });

  it('keeps the popup 8px inside the viewport horizontally', () => {
    expect(computeAnchoredPosition(rect(900, 50, 40, 40), menu, viewport, 'bottom-start', 4).left).toBe(752);
    expect(computeAnchoredPosition(rect(10, 50, 40, 40), menu, viewport, 'bottom-end', 4).left).toBe(8);
  });

  it('uses the roomier side and clamps when neither side fits', () => {
    const tall = { width: 240, height: 600 };
    const position = computeAnchoredPosition(rect(100, 300, 40, 40), tall, viewport, 'bottom-start', 4);
    expect(position.side).toBe('bottom');
    expect(position.top).toBe(192);
    expect(position.top + tall.height).toBeLessThanOrEqual(viewport.height - 8);
  });

  it('pins an oversized popup to the margin', () => {
    const huge = { width: 2000, height: 2000 };
    expect(computeAnchoredPosition(rect(100, 300, 40, 40), huge, viewport)).toMatchObject({ top: 8, left: 8 });
  });
});

describe('computeTooltipPosition', () => {
  const tip = { width: 80, height: 28 };

  it('centers below the trigger by default', () => {
    expect(computeTooltipPosition(rect(460, 100, 40, 40), tip, viewport))
      .toEqual({ top: 148, left: 440, side: 'bottom' });
  });

  it('flips to the top near the bottom edge', () => {
    expect(computeTooltipPosition(rect(460, 760, 40, 40), tip, viewport))
      .toEqual({ top: 724, left: 440, side: 'top' });
  });

  it('stays inside the viewport near the left edge', () => {
    expect(computeTooltipPosition(rect(0, 100, 40, 40), tip, viewport).left).toBe(8);
  });

  it('supports left and right, flipping when needed', () => {
    expect(computeTooltipPosition(rect(460, 100, 40, 40), tip, viewport, 'right'))
      .toEqual({ top: 106, left: 508, side: 'right' });
    expect(computeTooltipPosition(rect(20, 100, 40, 40), tip, viewport, 'left').side).toBe('right');
  });
});

describe('transformOriginFor', () => {
  it('grows from the corner next to the anchor', () => {
    expect(transformOriginFor('bottom-end', 'bottom')).toBe('top right');
    expect(transformOriginFor('bottom-start', 'top')).toBe('bottom left');
  });
});
