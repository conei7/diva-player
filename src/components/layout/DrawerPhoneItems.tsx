import { lazy, Suspense, useEffect, useState } from 'react';
import type { ButtonHTMLAttributes } from 'react';
import { useTranslateSourceText } from '../../i18n';
import { useLayoutSwitch } from '../../hooks/useLayoutSwitch';
import { useThemeSwitch } from '../../hooks/useThemeSwitch';
import { useLanguageStore } from '../../stores/languageStore';
import { usePlayerStore } from '../../stores/playerStore';
import { whenIdle } from '../../routes/routeLoaders';
import Switch from '../ui/Switch';
import { EyeIcon, LanguageIcon, MoonIcon, MusicNoteIcon } from '../ui/iconsChrome';
import { cx } from '../ui/overlay';
import { DeferredBoundary } from './RouteErrorBoundary';
import { useFocusHandoff } from './focusHandoff';
import { GUIDE_ROW_CLASS, guideRowStateClass } from './navItems';

// The language sheet (and the Menu code) loads after the first paint, outside the initial JavaScript (§1-12).
const loadLanguageMenu = () => import('./DrawerLanguageMenu');
const DrawerLanguageMenu = lazy(loadLanguageMenu);
const preloadLanguageMenu = () => void loadLanguageMenu().catch(() => undefined);

/**
 * Language, layout, theme and hidden mode rows at the end of the drawer on phones (no top-bar ⋮ there).
 * The layout row is a switch (ミュージック表示 on = ミュージック, off = 動画): one tap from the drawer.
 * So is the theme row (ダークモード on = ダーク, off = ライト; it shows the theme on screen, and a tap
 * saves the choice, leaving 「端末の設定に合わせる」 until Settings picks it again).
 * The drawer (Sidebar) loads this module after the first paint, outside the initial JavaScript
 * (§1-12): the drawer is closed and off screen until a tap opens it.
 */
export default function DrawerPhoneItems() {
  const t = useTranslateSourceText();
  const language = useLanguageStore(state => state.language);
  const hiddenMode = usePlayerStore(state => state.hiddenMode);
  const toggleHiddenMode = usePlayerStore(state => state.toggleHiddenMode);
  const { layout, changeLayout } = useLayoutSwitch();
  const { shown: shownTheme, changeMode } = useThemeSwitch();
  const [languageMenuOpen, setLanguageMenuOpen] = useState(false);
  // The loaded sheet's row replaces the placeholder row; a keyboard focus on it moves along.
  const languageRowRef = useFocusHandoff<HTMLButtonElement>();
  useEffect(() => whenIdle(preloadLanguageMenu), []);

  const languageRow = (props: ButtonHTMLAttributes<HTMLButtonElement> = {}) => (
    <button ref={languageRowRef} type="button" {...props} className={cx(GUIDE_ROW_CLASS, guideRowStateClass(false), 'cursor-pointer')}>
      <LanguageIcon />
      <span className="min-w-0 flex-1 truncate">
        {t('表示言語: {language}', { language: language === 'ja' ? '日本語' : 'English' })}
      </span>
    </button>
  );

  // The same row until the sheet's code has loaded; a press made meanwhile opens it once it is
  // here, and a focus on it moves to the loaded row (languageRowRef on both).
  const openLanguageMenu = () => {
    preloadLanguageMenu();
    setLanguageMenuOpen(true);
  };
  const languageFallback = languageRow({
    'aria-haspopup': 'menu',
    'aria-expanded': languageMenuOpen,
    onFocus: preloadLanguageMenu,
    onClick: openLanguageMenu,
    onKeyDown: event => {
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      event.preventDefault();
      openLanguageMenu();
    },
  });

  return (
    <>
      <li>
        <DeferredBoundary fallback={languageFallback}>
          <Suspense fallback={languageFallback}>
            <DrawerLanguageMenu trigger={languageRow()} open={languageMenuOpen} onOpenChange={setLanguageMenuOpen} />
          </Suspense>
        </DeferredBoundary>
      </li>
      <li>
        <Switch
          checked={layout === 'music'}
          onChange={checked => void changeLayout(checked ? 'music' : 'standard')}
          label={(
            <span className="flex min-w-0 items-center gap-6">
              <MusicNoteIcon />
              <span className="min-w-0 flex-1 truncate">{t('ミュージック表示')}</span>
            </span>
          )}
          className={cx(GUIDE_ROW_CLASS, guideRowStateClass(false))}
          id="drawer-music-layout"
        />
      </li>
      <li>
        <Switch
          checked={shownTheme === 'dark'}
          onChange={checked => changeMode(checked ? 'dark' : 'light')}
          label={(
            <span className="flex min-w-0 items-center gap-6">
              <MoonIcon />
              <span className="min-w-0 flex-1 truncate">{t('ダークモード')}</span>
            </span>
          )}
          className={cx(GUIDE_ROW_CLASS, guideRowStateClass(false))}
          id="drawer-dark-theme"
        />
      </li>
      {hiddenMode && (
        <li>
          <button
            type="button"
            className={cx(GUIDE_ROW_CLASS, guideRowStateClass(false), 'cursor-pointer')}
            onClick={toggleHiddenMode}
          >
            <EyeIcon />
            <span className="min-w-0 flex-1 truncate">{t('隠しモードを終了')}</span>
          </button>
        </li>
      )}
    </>
  );
}
