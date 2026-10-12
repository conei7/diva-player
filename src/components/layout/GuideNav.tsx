import { useId } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { useTranslate, useTranslateSourceText } from '../../i18n';
import { useUiStore } from '../../stores/uiStore';
import { SettingsIcon } from '../ui/iconsChrome';
import { cx } from '../ui/overlay';
import DiscoveryMixButton from './DiscoveryMixButton';
import { GUIDE_ROW_CLASS, GUIDE_SECTIONS, MINI_GUIDE_ITEMS, NAV_ITEMS, compactNavId, guideRowStateClass } from './navItems';
import type { NavId } from './navItems';
import { useActiveNavId, useNavLabels, useNavLinkProps } from './navHooks';

function GuideDivider() {
  return <hr className="my-3 h-px border-0 bg-yt-divider" />;
}

function GuideHeading({ id, children }: { id: string; children: ReactNode }) {
  return <h2 id={id} className="px-3 pb-1 pt-1.5 text-base font-bold leading-[22px] text-yt-text">{children}</h2>;
}

/**
 * The expanded guide (240px) and the drawer (DESIGN_SPEC §6.1.3): Home / Chorus highlights /
 * Favorite producers ─ Library ─ Explore (with the Discovery mix button) ─ Settings / Hidden songs
 * ─ footer. `inDrawer` closes the drawer after a press (`onNavigate`); `extraItems` go at the end
 * of the last section (the drawer adds the language and hidden mode rows on phones).
 */
export default function GuideNav({
  inDrawer = false,
  onNavigate,
  extraItems,
}: {
  inDrawer?: boolean;
  onNavigate?: () => void;
  extraItems?: ReactNode;
}) {
  const t = useTranslateSourceText();
  const tk = useTranslate();
  const headingId = useId();
  const activeId = useActiveNavId();
  const { full } = useNavLabels();
  const linkProps = useNavLinkProps(onNavigate);
  const openSettings = useUiStore(state => state.openSettings);

  const renderLink = (id: NavId) => {
    const item = NAV_ITEMS[id];
    const active = activeId === id;
    const Icon = active ? item.activeIcon : item.icon;
    return (
      <li key={id}>
        <Link
          to={item.to}
          aria-current={active ? 'page' : undefined}
          className={cx(GUIDE_ROW_CLASS, guideRowStateClass(active))}
          {...linkProps(item)}
        >
          <Icon />
          <span className="min-w-0 flex-1 truncate">{full[id]}</span>
        </Link>
      </li>
    );
  };

  return (
    <nav aria-label={t('メイン')} className="px-3 pt-3">
      <ul>{GUIDE_SECTIONS.main.map(renderLink)}</ul>
      <GuideDivider />
      <GuideHeading id={`${headingId}-library`}>{t('ライブラリ')}</GuideHeading>
      <ul aria-labelledby={`${headingId}-library`}>{GUIDE_SECTIONS.library.map(renderLink)}</ul>
      <GuideDivider />
      <GuideHeading id={`${headingId}-explore`}>{t('探索')}</GuideHeading>
      <ul aria-labelledby={`${headingId}-explore`}>
        {GUIDE_SECTIONS.explore.map(renderLink)}
        <li>
          <DiscoveryMixButton inDrawer={inDrawer} onStarted={onNavigate} />
        </li>
      </ul>
      <GuideDivider />
      <ul>
        <li>
          {/* No aria-label: the top bar's ⚙ is the one 「設定」 button tests and screen readers find. */}
          <button
            type="button"
            className={cx(GUIDE_ROW_CLASS, guideRowStateClass(false), 'cursor-pointer')}
            onClick={() => {
              onNavigate?.();
              openSettings();
            }}
          >
            <SettingsIcon />
            <span className="min-w-0 flex-1 truncate">{tk('settings')}</span>
          </button>
        </li>
        {GUIDE_SECTIONS.more.map(renderLink)}
        {extraItems}
      </ul>
      <GuideDivider />
      <p className="px-3 pb-6 pt-1 text-xs leading-[18px] text-yt-text-secondary">
        DIVA Player v0.1 ·{' '}
        <a
          href="https://vocadb.net"
          target="_blank"
          rel="noopener noreferrer"
          className="rounded-badge text-yt-text-secondary no-underline hover:text-yt-text"
        >
          {t('データ: VocaDB')}
        </a>
      </p>
    </nav>
  );
}

/** The 72px mini guide: five destinations, a 24px icon above a 10px label (DESIGN_SPEC §6.1.3). */
export function MiniGuideNav() {
  const t = useTranslateSourceText();
  // 後で聴く has no item here: プレイリスト stays selected while it is open.
  const activeId = compactNavId(useActiveNavId());
  const { short } = useNavLabels();
  const linkProps = useNavLinkProps();

  return (
    <nav aria-label={t('メイン')} className="px-1 pt-1">
      <ul className="flex flex-col items-center">
        {MINI_GUIDE_ITEMS.map(id => {
          const item = NAV_ITEMS[id];
          const active = activeId === id;
          const Icon = active ? item.activeIcon : item.icon;
          return (
            <li key={id}>
              <Link
                to={item.to}
                aria-current={active ? 'page' : undefined}
                className={cx(
                  'flex h-[74px] w-16 flex-col items-center justify-center gap-1.5 rounded-row px-0.5 text-yt-text no-underline transition-colors duration-150 hover:bg-yt-tonal [-webkit-tap-highlight-color:transparent]',
                  active && 'font-medium',
                )}
                {...linkProps(item)}
              >
                <Icon />
                <span className="max-w-full truncate text-[10px] leading-[14px]">{short[id]}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
