import { Link } from 'react-router';
import { useTranslate, useTranslateSourceText } from '../../../i18n';
import { useMediaQuery } from '../../../hooks/useMediaQuery';
import DiscoveryMixButton from '../../layout/DiscoveryMixButton';
import { NAV_ITEMS } from '../../layout/navItems';
import type { NavId, NavItem } from '../../layout/navItems';
import { useNavLabels } from '../../layout/navHooks';
import Tooltip from '../../ui/Tooltip';
import { cx } from '../../ui/overlay';
import { LIBRARY_ROW_CLASS, RAIL_CAPTION_MEDIA_QUERY, libraryNavStateClass } from './libraryModel';
import { RailTooltip } from './LibraryRow';
import type { NavLinkHandlers } from './LibraryRow';

/** The main destinations above the library (the rest are library entries or in the footer). */
const TOP_NAV_ITEMS: readonly NavId[] = ['home', 'chorus', 'soundMap', 'knowledgeMap'];

/**
 * 発掘ミックス is the guide's own button (GUIDE_ROW_CLASS). Restyle it from outside to the column's
 * rows; in the rail only its icon shows, or with captions its label as a line under it (the button
 * keeps its aria-label and the live status text).
 */
const MIX_ROW_CLASS =
  '[&>button]:rounded-lg [&>button]:font-bold [&>button]:text-yt-text-secondary [&>button:hover]:bg-transparent [&>button:hover]:text-yt-text';
const MIX_FULL_CLASS = `${MIX_ROW_CLASS} [&>button]:gap-4`;
const MIX_RAIL_CLASS = `${MIX_FULL_CLASS} [&>button]:h-11 [&>button]:justify-center [&>button]:px-0 [&>button>span]:sr-only`;
/** The rail with captions: the label (and the live status) as a 10px line under the icon. */
const MIX_CAPTION_CLASS = `${MIX_ROW_CLASS} [&>button]:h-14 [&>button]:flex-col [&>button]:justify-center [&>button]:gap-0.5 [&>button]:px-0 [&>button>span]:max-w-full [&>button>span]:flex-none [&>button>span]:text-[10px] [&>button>span]:leading-[14px]`;

/** The name under a rail icon (RAIL_CAPTION_MEDIA_QUERY). The link keeps its aria-label. */
const RAIL_CAPTION_CLASS = 'max-w-full truncate text-[10px] leading-[14px]';

/**
 * Top of the library column (does not scroll): ホーム, サビ発掘, 曲調マップ, 網羅率 and the
 * 発掘ミックス button. The selected destination has aria-current="page" and its filled icon.
 * On touch tablets the rail shows each name under its icon (there are no tooltips for touch).
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
  const { full, short } = useNavLabels();
  const captionScreen = useMediaQuery(RAIL_CAPTION_MEDIA_QUERY);
  const captions = rail && captionScreen;

  return (
    // With captions the rows are 64px wide (like the rail's list rows and the mini guide), so a
    // 6-character name such as 発掘ミックス fits at 10px instead of ending in 「…」.
    <nav aria-label={t('メイン')} className={cx('shrink-0', captions ? 'px-1 py-2' : 'p-2')}>
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
                    captions
                      ? 'h-14 flex-col justify-center gap-0.5'
                      : rail ? 'h-11 justify-center' : 'h-10 gap-4 px-3 text-sm leading-5',
                  )}
                  {...linkProps(item)}
                >
                  <Icon />
                  {captions && <span aria-hidden="true" className={RAIL_CAPTION_CLASS}>{short[id] ?? full[id]}</span>}
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
            <div className={captions ? MIX_CAPTION_CLASS : rail ? MIX_RAIL_CLASS : MIX_FULL_CLASS}>
              <DiscoveryMixButton inDrawer={rail} />
            </div>
          </Tooltip>
        </li>
      </ul>
    </nav>
  );
}
