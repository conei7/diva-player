import type { MouseEvent } from 'react';
import { Link } from 'react-router';
import { useTranslateSourceText } from '../../i18n';
import { usePlayerStore } from '../../stores/playerStore';
import { MusicNoteIcon } from '../ui/iconsChrome';
import { cx } from '../ui/overlay';

/**
 * The DIVA Player logo (DESIGN_SPEC §6.1.2): a 28px mark (the only place that keeps the brand
 * gradient) and 「DIVA Player」 with DIVA in the brand color. Grey while hidden mode is on.
 * The mark alone (phones) keeps its place but gets a 40×40 tap target (6px wider on each side).
 */
export default function BrandLogo({
  showText = true,
  onClick,
  className,
}: {
  showText?: boolean;
  onClick?: (event: MouseEvent<HTMLAnchorElement>) => void;
  className?: string;
}) {
  const t = useTranslateSourceText();
  const hiddenMode = usePlayerStore(state => state.hiddenMode);

  return (
    <Link
      to="/"
      aria-label={t('DIVA Player ホーム')}
      onClick={onClick}
      className={cx(
        'flex h-10 shrink-0 items-center gap-1.5 rounded-row text-yt-text no-underline [-webkit-tap-highlight-color:transparent]',
        !showText && '-mx-1.5 px-1.5',
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cx('flex size-7 shrink-0 items-center justify-center rounded-lg text-white', hiddenMode && 'bg-yt-tonal-solid-hover')}
        style={hiddenMode ? undefined : { background: 'var(--gradient-brand)' }}
      >
        <MusicNoteIcon size={18} />
      </span>
      {showText && (
        <span aria-hidden="true" className="whitespace-nowrap text-lg font-bold leading-6 tracking-tight">
          <span className={hiddenMode ? 'text-yt-text-secondary' : 'text-brand'}>DIVA</span> Player
        </span>
      )}
    </Link>
  );
}
