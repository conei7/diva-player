import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HorizontalOverflow } from './useHorizontalOverflow';
import { observeHorizontalOverflow, readHorizontalOverflow, sameHorizontalOverflow } from './useHorizontalOverflow';

class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  observed: Element[] = [];
  disconnected = false;
  readonly callback: ResizeObserverCallback;
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    FakeResizeObserver.instances.push(this);
  }
  observe(target: Element) { this.observed.push(target); }
  unobserve() {}
  disconnect() { this.observed = []; this.disconnected = true; }
  resize() { this.callback([], this as unknown as ResizeObserver); }
}

class FakeMutationObserver {
  static instances: FakeMutationObserver[] = [];
  options: MutationObserverInit | undefined;
  disconnected = false;
  readonly callback: MutationCallback;
  constructor(callback: MutationCallback) {
    this.callback = callback;
    FakeMutationObserver.instances.push(this);
  }
  observe(_target: Node, options?: MutationObserverInit) { this.options = options; }
  disconnect() { this.disconnected = true; }
  takeRecords() { return []; }
  mutate() { this.callback([], this as unknown as MutationObserver); }
}

/** A row of actions on a 390px phone: 760px of pills, scrolled by `scrollLeft`. */
function fakeRow(box: { scrollLeft?: number; scrollWidth?: number; clientWidth?: number; children?: Element[] } = {}) {
  const listeners = new Set<EventListener>();
  const row = {
    scrollLeft: box.scrollLeft ?? 0,
    scrollWidth: box.scrollWidth ?? 760,
    clientWidth: box.clientWidth ?? 390,
    children: box.children ?? [],
    addEventListener: (type: string, listener: EventListener) => { if (type === 'scroll') listeners.add(listener); },
    removeEventListener: (type: string, listener: EventListener) => { if (type === 'scroll') listeners.delete(listener); },
    get scrollListeners() { return listeners.size; },
    scrollTo(left: number) {
      row.scrollLeft = left;
      for (const listener of listeners) listener(new Event('scroll'));
    },
  };
  return row;
}

const asElement = (row: ReturnType<typeof fakeRow>) => row as unknown as Element;
const child = (name: string) => ({ name }) as unknown as Element;

afterEach(() => {
  vi.unstubAllGlobals();
  FakeResizeObserver.instances = [];
  FakeMutationObserver.instances = [];
});

describe('readHorizontalOverflow', () => {
  it('has no fade while the row fits (sm+ wraps it)', () => {
    expect(readHorizontalOverflow({ scrollLeft: 0, scrollWidth: 640, clientWidth: 640 })).toEqual({ start: false, end: false });
  });

  it('marks the end at the start, both in between and the start at the end', () => {
    // 760px of actions in 390px: 370px to scroll
    expect(readHorizontalOverflow({ scrollLeft: 0, scrollWidth: 760, clientWidth: 390 })).toEqual({ start: false, end: true });
    expect(readHorizontalOverflow({ scrollLeft: 120, scrollWidth: 760, clientWidth: 390 })).toEqual({ start: true, end: true });
    expect(readHorizontalOverflow({ scrollLeft: 370, scrollWidth: 760, clientWidth: 390 })).toEqual({ start: true, end: false });
  });

  it('treats a position within 1px of an end as that end (zoom, fractional widths)', () => {
    expect(readHorizontalOverflow({ scrollLeft: 0.5, scrollWidth: 760, clientWidth: 390 }).start).toBe(false);
    expect(readHorizontalOverflow({ scrollLeft: 369.5, scrollWidth: 760, clientWidth: 390 }).end).toBe(false);
  });

  it('ignores rubber-band overscroll past either end', () => {
    expect(readHorizontalOverflow({ scrollLeft: -24, scrollWidth: 760, clientWidth: 390 })).toEqual({ start: false, end: true });
    expect(readHorizontalOverflow({ scrollLeft: 400, scrollWidth: 760, clientWidth: 390 })).toEqual({ start: true, end: false });
  });
});

describe('sameHorizontalOverflow', () => {
  it('compares both sides, not the object (the hook keeps the previous state when equal)', () => {
    expect(sameHorizontalOverflow({ start: false, end: true }, { start: false, end: true })).toBe(true);
    expect(sameHorizontalOverflow({ start: false, end: true }, { start: true, end: true })).toBe(false);
    expect(sameHorizontalOverflow({ start: true, end: true }, { start: true, end: false })).toBe(false);
  });
});

describe('observeHorizontalOverflow', () => {
  it('reports at once, then only changes while scrolling, until cleaned up', () => {
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    vi.stubGlobal('MutationObserver', FakeMutationObserver);
    const row = fakeRow();
    const reports: HorizontalOverflow[] = [];
    const cleanup = observeHorizontalOverflow(asElement(row), overflow => reports.push(overflow));
    expect(reports).toEqual([{ start: false, end: true }]);

    row.scrollTo(40);
    row.scrollTo(160);
    row.scrollTo(370);
    expect(reports).toEqual([
      { start: false, end: true },
      { start: true, end: true },
      { start: true, end: false },
    ]);

    cleanup();
    expect(row.scrollListeners).toBe(0);
    expect(FakeResizeObserver.instances[0]?.disconnected).toBe(true);
    expect(FakeMutationObserver.instances[0]?.disconnected).toBe(true);
  });

  it('observes the row and each action, so a wider label or a resize re-measures', () => {
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    vi.stubGlobal('MutationObserver', FakeMutationObserver);
    const share = child('share');
    const hide = child('hide');
    // An 800px window: the row wraps and fits
    const row = fakeRow({ scrollWidth: 800, clientWidth: 800, children: [share, hide] });
    const reports: HorizontalOverflow[] = [];
    observeHorizontalOverflow(asElement(row), overflow => reports.push(overflow));
    const [resizeObserver] = FakeResizeObserver.instances;
    expect(resizeObserver?.observed).toEqual([row, share, hide]);
    expect(reports).toEqual([{ start: false, end: false }]);

    // Down to a phone: the row scrolls
    Object.assign(row, { scrollWidth: 760, clientWidth: 390 });
    resizeObserver?.resize();
    expect(reports.at(-1)).toEqual({ start: false, end: true });

    // Scrolled to the end, then 表示しない → 再表示 makes the content shorter: still at the end
    row.scrollTo(370);
    Object.assign(row, { scrollWidth: 740, scrollLeft: 350 });
    resizeObserver?.resize();
    expect(reports.at(-1)).toEqual({ start: true, end: false });
    // English labels are wider: more past the end again
    row.scrollWidth = 820;
    resizeObserver?.resize();
    expect(reports.at(-1)).toEqual({ start: true, end: true });
  });

  it('starts observing an action that appears later (the video switch once the song plays)', () => {
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    vi.stubGlobal('MutationObserver', FakeMutationObserver);
    const share = child('share');
    const children = [share];
    const row = fakeRow({ scrollWidth: 390, clientWidth: 390, children });
    const reports: HorizontalOverflow[] = [];
    observeHorizontalOverflow(asElement(row), overflow => reports.push(overflow));
    const [resizeObserver] = FakeResizeObserver.instances;
    const [mutationObserver] = FakeMutationObserver.instances;
    expect(mutationObserver?.options).toEqual({ childList: true });
    expect(reports).toEqual([{ start: false, end: false }]);

    const videoSwitch = child('video switch');
    children.push(videoSwitch);
    row.scrollWidth = 560;
    mutationObserver?.mutate();
    expect(resizeObserver?.observed).toEqual([row, share, videoSwitch]);
    expect(reports.at(-1)).toEqual({ start: false, end: true });
  });

  it('still follows scrolling without ResizeObserver', () => {
    vi.stubGlobal('ResizeObserver', undefined);
    vi.stubGlobal('MutationObserver', FakeMutationObserver);
    const row = fakeRow();
    const reports: HorizontalOverflow[] = [];
    const cleanup = observeHorizontalOverflow(asElement(row), overflow => reports.push(overflow));
    row.scrollTo(370);
    expect(reports).toEqual([{ start: false, end: true }, { start: true, end: false }]);
    expect(FakeMutationObserver.instances).toHaveLength(0);
    expect(() => cleanup()).not.toThrow();
    expect(row.scrollListeners).toBe(0);
  });
});
