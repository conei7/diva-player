import { create } from 'zustand';
import { storage } from '../utils/storage';
import {
  UI_LAYOUT_KEY,
  UI_LAYOUT_STORAGE_KEY,
  applyUiLayoutPreference,
  normalizeUiLayout,
  readUiLayout,
  type UiLayout,
} from '../utils/uiLayout';

interface UiLayoutState {
  layout: UiLayout;
  /** Applies the layout even if it could not be saved; returns whether it was saved (like the theme). */
  setLayout: (layout: UiLayout) => boolean;
}

export const useUiLayoutStore = create<UiLayoutState>(set => ({
  layout: readUiLayout(),
  setLayout: value => {
    const layout = normalizeUiLayout(value);
    const saved = storage.set(UI_LAYOUT_KEY, layout);
    applyUiLayoutPreference(layout);
    set({ layout });
    return saved;
  },
}));

/**
 * Before React renders. Another tab's change is followed once its frame code is ready (`prepare`);
 * a later change made meanwhile wins.
 */
export function initializeUiLayout(prepare: (layout: UiLayout) => Promise<unknown>): void {
  applyUiLayoutPreference(useUiLayoutStore.getState().layout);
  window.addEventListener('storage', event => {
    if (event.storageArea !== localStorage || (event.key !== null && event.key !== UI_LAYOUT_STORAGE_KEY)) return;
    const layout = readUiLayout();
    if (layout === useUiLayoutStore.getState().layout) return;
    void prepare(layout).then(() => {
      if (readUiLayout() !== layout) return;
      applyUiLayoutPreference(layout);
      useUiLayoutStore.setState({ layout });
    }, error => console.error('[UiLayout] Could not load the layout chosen in another tab', error));
  });
}
