import { useState } from 'react';
import { useTranslateSourceText } from '../i18n';
import { ensureMusicShell } from '../components/music/musicShellLoader';
import { showToast } from '../stores/toastStore';
import { useUiLayoutStore } from '../stores/uiLayoutStore';
import type { UiLayout } from '../utils/uiLayout';
import { useIsMusicLayout } from './useMusicLayout';

/** The latest choice anywhere (Settings, the top bar's ⋮, the phone drawer) wins over earlier ones still downloading. */
let latestLayoutRequest = 0;

/**
 * Switching the layout (標準 / ミュージック). The music frame is loaded first, so the page and the
 * player stay as they are while it switches. `layout` is the one on screen (a music frame that failed
 * to download shows the standard one), or the choice being prepared while its code downloads, so the
 * control never jumps back meanwhile.
 */
export function useLayoutSwitch() {
  const t = useTranslateSourceText();
  const setLayout = useUiLayoutStore(state => state.setLayout);
  const shownLayout: UiLayout = useIsMusicLayout() ? 'music' : 'standard';
  const [pendingLayout, setPendingLayout] = useState<UiLayout | null>(null);

  const changeLayout = async (next: UiLayout): Promise<void> => {
    const request = ++latestLayoutRequest;
    if (next === 'music') {
      setPendingLayout(next);
      try {
        await ensureMusicShell();
      } catch (error) {
        console.error('[UiLayout] Could not load the music layout', error);
        setPendingLayout(null);
        if (request === latestLayoutRequest) {
          showToast(t('レイアウトを切り替えられませんでした'), {
            action: { label: t('再試行'), onAction: () => void changeLayout(next) },
          });
        }
        return;
      }
    }
    setPendingLayout(null);
    if (request !== latestLayoutRequest) return;
    if (!setLayout(next)) showToast(t('レイアウトは適用しましたが保存できませんでした'));
  };

  return { layout: pendingLayout ?? shownLayout, changeLayout };
}
