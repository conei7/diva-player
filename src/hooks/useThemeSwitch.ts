import { useTranslateSourceText } from '../i18n';
import { showToast } from '../stores/toastStore';
import { useThemeStore } from '../stores/themeStore';
import { PREFERS_LIGHT_MEDIA_QUERY, shownThemeMode } from '../utils/theme';
import type { ThemeMode } from '../utils/theme';
import { useMediaQuery } from './useMediaQuery';

/**
 * Switching the theme (端末の設定に合わせる / ダーク / ライト) from Settings, the top bar (☀/☾ and ⋮)
 * and the phone drawer. `mode` is the saved choice; `shown` is the theme on screen (under
 * 'system', the device's, following it as it changes).
 */
export function useThemeSwitch() {
  const t = useTranslateSourceText();
  const mode = useThemeStore(state => state.mode);
  const setMode = useThemeStore(state => state.setMode);
  const shown = shownThemeMode(mode, useMediaQuery(PREFERS_LIGHT_MEDIA_QUERY));

  const changeMode = (next: ThemeMode) => {
    if (!setMode(next)) showToast(t('テーマは適用しましたが保存できませんでした'));
  };

  return { mode, shown, changeMode };
}
