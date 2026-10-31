import { Link } from 'react-router';
import { useTranslate, useTranslateSourceText } from '../../../i18n';
import DiscoveryMixButton from '../../layout/DiscoveryMixButton';
import { NAV_ITEMS } from '../../layout/navItems';
import type { NavId, NavItem } from '../../layout/navItems';
import { useNavLabels } from '../../layout/navHooks';
import Tooltip from '../../ui/Tooltip';
import { cx } from '../../ui/overlay';
import { LIBRARY_ROW_CLASS, libraryNavStateClass } from './libraryModel';
import { RailTooltip } from './LibraryRow';
import type { NavLinkHandlers } from './LibraryRow';

/** The main destinations above the library (the rest are library entries or in the footer). */
const TOP_NAV_ITEMS: readonly NavId[] = ['home', 'chorus', 'soundMap', 'knowledgeMap'];

/**
 * 発掘ミックス is the guide's own button (GUIDE_ROW_CLASS). Restyle it from outside to the column's
 * rows; in the rail only its icon shows (the button keeps its aria-label and the live status text).
 */
const MIX_FULL_CLASS =
  '[&>button]:gap-4 [&>button]:rounded-lg [&>button]:font-medium [&>button]:text-yt-text-secondary [&>button:hover]:text-yt-text';
const MIX_RAIL_CLASS = `${MIX_FULL_CLASS} [&>button]:h-11 [&>button]:justify-center [&>button]:px-0 [&>button>span]:sr-only`;

/**
 * Top of the library column (does not scroll): ホーム, サビ発掘, 曲調マップ, 知ってる度 and the
 * 発掘ミックス button. The selected destination has aria-current="page" and its filled icon.
 */
export default function LibraryNav({
  rail,
  activeId,
  linkProps,
}: {
  rail: boolean;
  activeId: NavId | null;
  linkProps: (item: NavItem) => NavLinkHandlers;
}) {
  const t = useTranslateSourceText();
  const tk = useTranslate();
  const { full } = useNavLabels();

  return (
    <nav aria-label={t('メイン')} className="shrink-0 p-2">
      <ul className="flex flex-col gap-0.5">
        {TOP_NAV_ITEMS.map(id => {
          const item = NAV_ITEMS[id];
          const active = activeId === id;
          const Icon = active ? item.activeIcon : item.icon;
          return (
            <li key={id}>
              <RailTooltip rail={rail} label={full[id]}>
                <Link
                  to={item.to}
                  aria-current={active ? 'page' : undefined}
                  aria-label={rail ? full[id] : undefined}
                  className={cx(
                    LIBRARY_ROW_CLASS,
                    libraryNavStateClass(active),
                    rail ? 'h-11 justify-center' : 'h-10 gap-4 px-3 text-sm leading-5',
                  )}
                  {...linkProps(item)}
                >
                  <Icon />
                  {!rail && <span className="min-w-0 flex-1 truncate">{full[id]}</span>}
                </Link>
              </RailTooltip>
            </li>
          );
        })}
        <li>
          {/*
            Always under a Tooltip (empty outside the rail) so a mix being built keeps its status when
            the column switches between rail and full. The tooltip needs an element that takes a ref:
            the wrapper; the button inside keeps its own aria-label. In the rail the status text is
            not visible, so a started mix is also announced with a toast (inDrawer).
          */}
          <Tooltip content={rail ? tk('discoveryMix') : ''} placement="right">
            <div className={rail ? MIX_RAIL_CLASS : MIX_FULL_CLASS}>
              <DiscoveryMixButton inDrawer={rail} />
            </div>
          </Tooltip>
        </li>
      </ul>
    </nav>
  );
}
