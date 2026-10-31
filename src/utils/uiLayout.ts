import { storage } from './storage';

/** localStorage `diva_uiLayout` (JSON). Missing or unknown values keep the standard layout. */
export const UI_LAYOUT_KEY = 'uiLayout';
export const UI_LAYOUT_STORAGE_KEY = 'diva_uiLayout';
export type UiLayout = 'standard' | 'music';
export const DEFAULT_UI_LAYOUT: UiLayout = 'standard';

export function isUiLayout(value: unknown): value is UiLayout {
  return value === 'standard' || value === 'music';
}

export function normalizeUiLayout(value: unknown): UiLayout {
  return value === 'music' ? 'music' : DEFAULT_UI_LAYOUT;
}

export function readUiLayout(): UiLayout {
  return normalizeUiLayout(storage.get<unknown>(UI_LAYOUT_KEY));
}

/**
 * The saved choice as `<html data-ui-layout>` (public/startup.js sets it before React). Layout
 * variables follow `data-shell`, which only exists while the music frame is actually mounted.
 */
export function applyUiLayoutPreference(layout: UiLayout): void {
  if (typeof document === 'undefined') return;
  document.documentElement.dataset.uiLayout = layout;
}
