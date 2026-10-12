import type { ReactElement } from 'react';
import { useTranslateSourceText } from '../../i18n';
import { useLanguageStore } from '../../stores/languageStore';
import Menu, { MenuItemRadio } from '../ui/Menu';

/**
 * 「表示言語」 in the drawer on phones (DESIGN_SPEC §6.1.3): a bottom sheet with 日本語 / English.
 * The drawer (Sidebar) loads this after the first paint and shows the same row until then; a
 * press made meanwhile opens the sheet as soon as it is here.
 */
export default function DrawerLanguageMenu({
  trigger,
  open,
  onOpenChange,
}: {
  trigger: ReactElement;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslateSourceText();
  const language = useLanguageStore(state => state.language);
  const setLanguage = useLanguageStore(state => state.setLanguage);

  return (
    <Menu label={t('表示言語')} open={open} onOpenChange={onOpenChange} trigger={trigger}>
      <MenuItemRadio checked={language === 'ja'} onSelect={() => void setLanguage('ja')}>日本語</MenuItemRadio>
      <MenuItemRadio checked={language === 'en'} onSelect={() => void setLanguage('en')}>English</MenuItemRadio>
    </Menu>
  );
}
