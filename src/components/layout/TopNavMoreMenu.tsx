import type { Ref } from 'react';
import { useTranslateSourceText } from '../../i18n';
import { useLanguageStore } from '../../stores/languageStore';
import { usePlayerStore } from '../../stores/playerStore';
import { useUiStore } from '../../stores/uiStore';
import IconButton from '../ui/IconButton';
import Menu, { MenuDivider, MenuItem, MenuItemRadio, MenuLabel } from '../ui/Menu';
import { EyeIcon, KeyboardIcon, MoreVertIcon } from '../ui/iconsChrome';

/**
 * The top bar's ⋮ 「その他の操作」 (DESIGN_SPEC §6.1.2): 表示言語, キーボード ショートカット and, in
 * hidden mode, 隠しモードを終了. TopNav loads it after the first paint and shows the same button
 * until then (a press made meanwhile opens the menu as soon as it is here; `triggerRef` moves a
 * focus on that button to this one).
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

  return (
    <Menu
      align="end"
      width={280}
      open={open}
      onOpenChange={onOpenChange}
      trigger={<IconButton ref={triggerRef} label={t('その他の操作')} icon={<MoreVertIcon />} className="topnav-action-btn" />}
    >
      <MenuLabel>{t('表示言語')}</MenuLabel>
      <MenuItemRadio checked={language === 'ja'} onSelect={() => void setLanguage('ja')}>日本語</MenuItemRadio>
      <MenuItemRadio checked={language === 'en'} onSelect={() => void setLanguage('en')}>English</MenuItemRadio>
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
