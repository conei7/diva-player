import { useTranslateSourceText } from '../../i18n';
import { useThemeSwitch } from '../../hooks/useThemeSwitch';
import { oppositeThemeMode } from '../../utils/theme';
import IconButton from '../ui/IconButton';
import { Svg } from '../ui/iconBase';
import type { IconProps } from '../ui/iconBase';
import { MoonIcon } from '../ui/iconsChrome';
import { STROKE } from '../ui/iconStroke';

/** ライト (the top bar's theme switch): a sun. */
function SunIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="4" {...STROKE} />
      <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4" {...STROKE} />
    </Svg>
  );
}

/**
 * The top bar's theme switch: one press changes ダーク ⇄ ライト. It shows where a press goes (☀ on the
 * dark theme, ☾ on the light one) and saves that as the choice, so a device set to 「端末の設定に
 * 合わせる」 stops following the device until Settings > 見た目 or the ⋮ menu picks it again. TopNav
 * loads this module after the first paint, outside the initial JavaScript (§1-12), and shows it from
 * 768px; narrower screens use the ⋮ menu (640px and up) or the phone drawer's ダークモード switch.
 */
export default function ThemeToggle() {
  const t = useTranslateSourceText();
  const { shown, changeMode } = useThemeSwitch();
  const next = oppositeThemeMode(shown);
  return (
    <IconButton
      label={next === 'light' ? t('ライトモードに切り替え') : t('ダークモードに切り替え')}
      icon={next === 'light' ? <SunIcon /> : <MoonIcon />}
      className="topnav-action-btn"
      data-testid="topnav-theme-toggle"
      data-theme-target={next}
      onClick={() => changeMode(next)}
    />
  );
}
