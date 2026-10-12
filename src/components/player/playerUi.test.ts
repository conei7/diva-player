import { describe, expect, it } from 'vitest';
import {
  clampFraction,
  formatRemainingClock,
  getChorusRange,
  getQueuePosition,
  getSleepTimerChoice,
  hasCommandModifier,
  isInteractiveTarget,
  isTextEntryTarget,
  pointerFraction,
  recordSleepTimerChoice,
} from './playerUi';

/** A stand-in element: `closest` matches when the selector list contains one of `matches`. */
function fakeElement(matches: string[], isContentEditable = false) {
  return {
    isContentEditable,
    closest(selector: string) {
      const candidates = selector.split(',').map(part => part.trim());
      return matches.some(match => candidates.includes(match)) ? this : null;
    },
  };
}

describe('getQueuePosition', () => {
  it('counts only the songs the user queued', () => {
    expect(getQueuePosition(['manual', 'manual', 'manual', 'auto', 'auto'], 1)).toEqual({ position: 2, total: 3 });
    expect(getQueuePosition(['discovery', 'discovery', 'auto'], 0)).toEqual({ position: 1, total: 2 });
  });

  it('hides the position for autoplayed songs, single songs and invalid indexes', () => {
    expect(getQueuePosition(['manual', 'manual', 'auto'], 2)).toBeNull();
    expect(getQueuePosition(['manual', 'auto', 'auto'], 0)).toBeNull();
    expect(getQueuePosition([], 0)).toBeNull();
    expect(getQueuePosition(['manual', 'manual'], -1)).toBeNull();
    expect(getQueuePosition(['manual', 'manual'], 5)).toBeNull();
  });
});

describe('isInteractiveTarget', () => {
  it('leaves keys to controls, dialogs and menus', () => {
    for (const match of ['input', 'textarea', 'select', 'button', 'a[href]', 'summary', '[role="slider"]', '[role="tab"]', '[role="menuitemradio"]', '[role="dialog"]', '[role="menu"]']) {
      expect(isInteractiveTarget(fakeElement([match]))).toBe(true);
    }
    expect(isInteractiveTarget(fakeElement([], true))).toBe(true);
  });

  it('lets the page body and plain text drive the player', () => {
    expect(isInteractiveTarget(fakeElement([]))).toBe(false);
    expect(isInteractiveTarget(null)).toBe(false);
    expect(isInteractiveTarget({})).toBe(false);
  });
});

describe('isTextEntryTarget', () => {
  it('is true only where the user types or inside a dialog / menu', () => {
    expect(isTextEntryTarget(fakeElement(['input']))).toBe(true);
    expect(isTextEntryTarget(fakeElement(['[role="dialog"]']))).toBe(true);
    expect(isTextEntryTarget(fakeElement(['button']))).toBe(false);
    expect(isTextEntryTarget(fakeElement([]))).toBe(false);
  });
});

describe('hasCommandModifier', () => {
  it('detects Alt, Ctrl and Meta but not Shift', () => {
    expect(hasCommandModifier({ altKey: true, ctrlKey: false, metaKey: false })).toBe(true);
    expect(hasCommandModifier({ altKey: false, ctrlKey: true, metaKey: false })).toBe(true);
    expect(hasCommandModifier({ altKey: false, ctrlKey: false, metaKey: true })).toBe(true);
    expect(hasCommandModifier({ altKey: false, ctrlKey: false, metaKey: false })).toBe(false);
  });
});

describe('progress helpers', () => {
  it('clamps fractions and maps the pointer onto the track', () => {
    expect(clampFraction(-0.5)).toBe(0);
    expect(clampFraction(1.5)).toBe(1);
    expect(clampFraction(Number.NaN)).toBe(0);
    expect(pointerFraction(150, { left: 100, width: 200 })).toBe(0.25);
    expect(pointerFraction(50, { left: 100, width: 200 })).toBe(0);
    expect(pointerFraction(150, { left: 100, width: 0 })).toBe(0);
  });

  it('returns the chorus as fractions, with a 15 second default length', () => {
    expect(getChorusRange(50, 75, 200)).toEqual({ start: 0.25, end: 0.375 });
    expect(getChorusRange(50, null, 200)).toEqual({ start: 0.25, end: 0.325 });
    expect(getChorusRange(195, null, 200)).toEqual({ start: 0.975, end: 1 });
    expect(getChorusRange(null, 75, 200)).toBeNull();
    expect(getChorusRange(50, 75, 0)).toBeNull();
    expect(getChorusRange(250, null, 200)).toBeNull();
  });
});

describe('sleep timer helpers', () => {
  it('formats the remaining time rounded up to the second', () => {
    expect(formatRemainingClock(754_000)).toBe('12:34');
    expect(formatRemainingClock(1)).toBe('0:01');
    expect(formatRemainingClock(0)).toBe('0:00');
    expect(formatRemainingClock(3_723_000)).toBe('1:02:03');
  });

  it('remembers which option started the running timer', () => {
    const now = 1_000_000;
    recordSleepTimerChoice(now + 30 * 60_000, now);
    expect(getSleepTimerChoice(now + 30 * 60_000)).toBe(30);
    expect(getSleepTimerChoice(now + 15 * 60_000)).toBeNull();
    recordSleepTimerChoice(null);
    expect(getSleepTimerChoice(now + 30 * 60_000)).toBeNull();
  });
});
