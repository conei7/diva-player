import { useTranslateSourceText } from '../../i18n';
import { useLayoutSwitch } from '../../hooks/useLayoutSwitch';
import type { UiLayout } from '../../utils/uiLayout';
import IconButton from '../ui/IconButton';
import Tooltip from '../ui/Tooltip';
import { Svg } from '../ui/iconBase';
import type { IconProps } from '../ui/iconBase';
import { STROKE } from '../ui/iconStroke';
import { cx } from '../ui/overlay';

const LAYOUTS: readonly UiLayout[] = ['standard', 'music'];

/** 動画 layout (the top bar's layout switch): a screen with a play triangle. */
function VideoLayoutIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="3" y="5" width="18" height="14" rx="2.5" {...STROKE} />
      <path d="M10 9.3v5.4a.5.5 0 0 0 .76.43l4.4-2.7a.5.5 0 0 0 0-.86l-4.4-2.7a.5.5 0 0 0-.76.43z" />
    </Svg>
  );
}

/** ミュージック layout (the top bar's layout switch): headphones. */
function MusicLayoutIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 17v-4a8 8 0 0 1 16 0v4" {...STROKE} />
      <path d="M3 14.5A1.5 1.5 0 0 1 4.5 13H6a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H4.5A1.5 1.5 0 0 1 3 18.5zm18 0a1.5 1.5 0 0 0-1.5-1.5H18a2 2 0 0 0-2 2v3a2 2 0 0 0 2 2h1.5a1.5 1.5 0 0 0 1.5-1.5z" />
    </Svg>
  );
}

/**
 * The top bar's layout switch: 動画 (the YouTube-like frame) and ミュージック (library, now playing and
 * the player bar), one press away on every page. Desktop: both as a two-icon pill, the one on screen
 * pressed. Phones: one button that switches to the other layout (TopNav shows it where the bar has no ≡;
 * there the drawer's switch is one tap away). TopNav loads this module (and its two icons) after the
 * first paint, outside the initial JavaScript (§1-12). Settings > 見た目 and the phone drawer
 * keep the same choice (useLayoutSwitch: the latest press wins).
 */
export default function LayoutToggle({ compact = false }: { compact?: boolean }) {
  const t = useTranslateSourceText();
  const { layout, changeLayout } = useLayoutSwitch();
  const nameOf = (value: UiLayout) => (value === 'music' ? t('ミュージック表示') : t('動画表示'));
  const iconOf = (value: UiLayout, size?: number) => (value === 'music' ? <MusicLayoutIcon size={size} /> : <VideoLayoutIcon size={size} />);

  if (compact) {
    const next: UiLayout = layout === 'music' ? 'standard' : 'music';
    return (
      <IconButton
        label={t('{layout}に切り替え', { layout: nameOf(next) })}
        icon={iconOf(next)}
        className="topnav-action-btn max-sm:size-11!"
        data-testid="topnav-layout-toggle"
        onClick={() => void changeLayout(next)}
      />
    );
  }

  return (
    <div role="group" aria-label={t('レイアウト')} className="flex h-9 shrink-0 items-center rounded-full bg-yt-tonal p-0.5">
      {LAYOUTS.map(value => {
        const active = layout === value;
        return (
          <Tooltip key={value} content={nameOf(value)}>
            <button
              type="button"
              aria-label={nameOf(value)}
              aria-pressed={active}
              data-testid={`topnav-layout-${value}`}
              onClick={() => { if (!active) void changeLayout(value); }}
              className={cx(
                'flex h-8 w-10 cursor-pointer items-center justify-center rounded-full transition-colors duration-150 [-webkit-tap-highlight-color:transparent]',
                active ? 'bg-yt-inverse text-yt-on-inverse' : 'text-yt-text-secondary hover:text-yt-text',
              )}
            >
              {iconOf(value, 20)}
            </button>
          </Tooltip>
        );
      })}
    </div>
  );
}
