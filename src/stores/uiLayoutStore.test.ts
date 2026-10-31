import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isUiLayout, normalizeUiLayout, readUiLayout } from '../utils/uiLayout';
import { useUiLayoutStore } from './uiLayoutStore';

describe('layout preference', () => {
  let values: Map<string, string>;
  let failWrites: boolean;

  beforeEach(() => {
    values = new Map();
    failWrites = false;
    vi.stubGlobal('localStorage', {
      get length() { return values.size; },
      clear: () => values.clear(),
      getItem: (key: string) => values.get(key) ?? null,
      key: (index: number) => [...values.keys()][index] ?? null,
      removeItem: (key: string) => values.delete(key),
      setItem: (key: string, value: string) => {
        if (failWrites) throw new DOMException('Quota exceeded', 'QuotaExceededError');
        values.set(key, String(value));
      },
    } satisfies Storage);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    useUiLayoutStore.setState({ layout: 'standard' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('keeps the standard layout for missing, broken or unknown values', () => {
    for (const value of [null, undefined, {}, 'Music', 'youtube', 1, 'standard']) expect(normalizeUiLayout(value)).toBe('standard');
    expect(normalizeUiLayout('music')).toBe('music');
    expect(isUiLayout('music')).toBe(true);
    expect(isUiLayout('compact')).toBe(false);
    expect(readUiLayout()).toBe('standard');
    values.set('diva_uiLayout', 'music');
    expect(readUiLayout()).toBe('standard');
    values.set('diva_uiLayout', JSON.stringify('music'));
    expect(readUiLayout()).toBe('music');
  });

  it('saves the choice as JSON under diva_uiLayout without touching other data', () => {
    values.set('diva_themeMode', JSON.stringify('light'));
    expect(useUiLayoutStore.getState().setLayout('music')).toBe(true);
    expect(values.get('diva_uiLayout')).toBe('"music"');
    expect(values.get('diva_themeMode')).toBe('"light"');
    expect(useUiLayoutStore.getState().layout).toBe('music');
    expect(useUiLayoutStore.getState().setLayout('standard')).toBe(true);
    expect(values.get('diva_uiLayout')).toBe('"standard"');
  });

  it('still switches for this session when the choice cannot be saved', () => {
    failWrites = true;
    expect(useUiLayoutStore.getState().setLayout('music')).toBe(false);
    expect(useUiLayoutStore.getState().layout).toBe('music');
    expect(values.has('diva_uiLayout')).toBe(false);
  });
});
