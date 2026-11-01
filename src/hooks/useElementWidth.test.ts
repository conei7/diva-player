import { afterEach, describe, expect, it, vi } from 'vitest';
import { observeElementWidth } from './useElementWidth';

function fakeElement(width: number): Element {
  return { getBoundingClientRect: () => ({ width }) } as unknown as Element;
}

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
  disconnect() { this.disconnected = true; }
  resize(width: number) {
    this.callback([{ contentRect: { width } } as ResizeObserverEntry], this as unknown as ResizeObserver);
  }
}

/** A window whose root is `rootWidth` wide (narrower than `innerWidth` by a scrollbar). Read live. */
function stubWindow(view: { innerWidth: number; rootWidth: number }) {
  vi.stubGlobal('window', { get innerWidth() { return view.innerWidth; } });
  vi.stubGlobal('document', { documentElement: { getBoundingClientRect: () => ({ width: view.rootWidth }) } });
}

afterEach(() => {
  vi.unstubAllGlobals();
  FakeResizeObserver.instances = [];
});

describe('observeElementWidth', () => {
  it('reports the width at once (before paint), then every resize, until cleaned up', () => {
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    const node = fakeElement(734);
    const widths: number[] = [];
    const cleanup = observeElementWidth(node, width => widths.push(width));

    expect(widths).toEqual([734]);
    const [observer] = FakeResizeObserver.instances;
    expect(observer?.observed).toEqual([node]);

    observer?.resize(1140);
    expect(widths).toEqual([734, 1140]);

    cleanup();
    expect(observer?.disconnected).toBe(true);
  });

  it('reports the first width to onWidth and later ones to onResize', () => {
    // useElementWidth renders resizes at once (flushSync), but not the first width: it is read
    // inside React's commit, while the ref is attached.
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    const first: number[] = [];
    const resized: number[] = [];
    observeElementWidth(fakeElement(734), width => first.push(width), width => resized.push(width));
    expect(first).toEqual([734]);
    expect(resized).toEqual([]);

    const [observer] = FakeResizeObserver.instances;
    observer?.resize(1088);
    observer?.resize(0);
    expect(first).toEqual([734]);
    expect(resized).toEqual([1088, 0]);
  });

  it('still reports the first width without ResizeObserver', () => {
    vi.stubGlobal('ResizeObserver', undefined);
    const widths: number[] = [];
    const cleanup = observeElementWidth(fakeElement(532), width => widths.push(width));
    expect(widths).toEqual([532]);
    expect(() => cleanup()).not.toThrow();
  });

  it('reports the same width whether the window scrollbar is shown or not', () => {
    // Music layout, 1360px window, library icons + 再生中 panel: 868px, or 857px beside an 11px scrollbar
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    const view = { innerWidth: 1360, rootWidth: 1349 };
    stubWindow(view);
    const widths: number[] = [];
    observeElementWidth(fakeElement(857), width => widths.push(width));
    const [observer] = FakeResizeObserver.instances;

    view.rootWidth = 1360;
    observer?.resize(868);
    view.rootWidth = 1349;
    observer?.resize(857);
    expect(widths).toEqual([868, 868, 868]);

    // A real resize still comes through: 944px (the lg-row threshold), 933px beside the scrollbar
    Object.assign(view, { innerWidth: 1436, rootWidth: 1425 });
    observer?.resize(933);
    expect(widths.at(-1)).toBe(944);
  });

  it('stays exact at fractional display scaling', () => {
    // 125%: the window is 1092.8px but innerWidth says 1092 (the root is wider); the scrollbar is 11.2px
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    const view = { innerWidth: 1092, rootWidth: 1092.8 };
    stubWindow(view);
    const widths: number[] = [];
    observeElementWidth(fakeElement(860.8), width => widths.push(width));
    const [observer] = FakeResizeObserver.instances;

    view.rootWidth = 1081.6;
    observer?.resize(849.6);
    expect(widths[1]).toBeCloseTo(widths[0] ?? 0, 9);
  });

  it('keeps 0 (not laid out), and ignores the root while pinch-zoomed or without layout', () => {
    vi.stubGlobal('ResizeObserver', undefined);
    const widths: number[] = [];
    stubWindow({ innerWidth: 1360, rootWidth: 1349 });
    observeElementWidth(fakeElement(0), width => widths.push(width));
    // Pinch zoom: innerWidth follows the 680px visual viewport
    stubWindow({ innerWidth: 680, rootWidth: 1360 });
    observeElementWidth(fakeElement(868), width => widths.push(width));
    // jsdom: innerWidth 1024, but no layout
    stubWindow({ innerWidth: 1024, rootWidth: 0 });
    observeElementWidth(fakeElement(734), width => widths.push(width));
    expect(widths).toEqual([0, 868, 734]);
  });
});
