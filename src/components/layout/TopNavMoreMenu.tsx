import type { Ref } from 'react';
import { useTranslateSourceText } from '../../i18n';
import { useThemeSwitch } from '../../hooks/useThemeSwitch';
import { useLanguageStore } from '../../stores/languageStore';
import { usePlayerStore } from '../../stores/playerStore';
import { useUiStore } from '../../stores/uiStore';
import IconButton from '../ui/IconButton';
import Menu, { MenuDivider, MenuGroup, MenuItem, MenuItemRadio } from '../ui/Menu';
import { EyeIcon, KeyboardIcon, MoreVertIcon } from '../ui/iconsChrome';

/**
 * The top bar's ⋮ 「その他の操作」 (DESIGN_SPEC §6.1.2): 表示言語, テーマ (with 端末の設定に合わせる,
 * which the top bar's ☀/☾ leaves), キーボード ショートカット and, in hidden mode, 隠しモードを終了.
 * The layout has its own switch in the top bar (LayoutToggle).
 * TopNav loads it after the first paint and shows the same button until then (a press made
 * meanwhile opens the menu as soon as it is here; `triggerRef` moves a focus on that button to
 * this one).
 */
export default function TopNavMoreMenu({
  open,
  onOpenChange,
  triggerRef,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  triggerRef?: Ref<HTMLButtonElement>;
}) {
  const t = useTranslateSourceText();
  const language = useLanguageStore(state => state.language);
  const setLanguage = useLanguageStore(state => state.setLanguage);
  const setKeyboardShortcutsOpen = useUiStore(state => state.setKeyboardShortcutsOpen);
  const hiddenMode = usePlayerStore(state => state.hiddenMode);
  const toggleHiddenMode = usePlayerStore(state => state.toggleHiddenMode);
  const { mode, changeMode } = useThemeSwitch();

  return (
    <Menu
      align="end"
      width={280}
      open={open}
      onOpenChange={onOpenChange}
      trigger={<IconButton ref={triggerRef} label={t('その他の操作')} icon={<MoreVertIcon />} className="topnav-action-btn" />}
    >
      <MenuGroup label={t('表示言語')}>
        <MenuItemRadio checked={language === 'ja'} onSelect={() => void setLanguage('ja')}>日本語</MenuItemRadio>
        <MenuItemRadio checked={language === 'en'} onSelect={() => void setLanguage('en')}>English</MenuItemRadio>
      </MenuGroup>
      <MenuDivider />
      <MenuGroup label={t('テーマ')}>
        <MenuItemRadio checked={mode === 'system'} onSelect={() => changeMode('system')}>{t('端末の設定に合わせる')}</MenuItemRadio>
        <MenuItemRadio checked={mode === 'dark'} onSelect={() => changeMode('dark')}>{t('ダーク')}</MenuItemRadio>
        <MenuItemRadio checked={mode === 'light'} onSelect={() => changeMode('light')}>{t('ライト')}</MenuItemRadio>
      </MenuGroup>
      <MenuDivider />
      <MenuItem icon={<KeyboardIcon />} hint="?" onSelect={() => setKeyboardShortcutsOpen(true)}>
        {t('キーボード ショートカット')}
      </MenuItem>
      {hiddenMode && (
        <MenuItem icon={<EyeIcon />} onSelect={toggleHiddenMode}>{t('隠しモードを終了')}</MenuItem>
      )}
    </Menu>
  );
}
