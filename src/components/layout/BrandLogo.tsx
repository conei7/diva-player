import type { MouseEvent } from 'react';
import { Link } from 'react-router';
import { useTranslateSourceText } from '../../i18n';
import { usePlayerStore } from '../../stores/playerStore';
import { cx } from '../ui/overlay';
import BrandMark from './BrandMark';

/**
 * The DIVA Player logo (DESIGN_SPEC §6.1.2): the 28px flat mark (BrandMark) and the 「DIVA Player」
 * wordmark (DIVA bold, Player lighter). The mark turns grey while hidden mode is on.
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
      <BrandMark muted={hiddenMode} />
      {showText && (
        <span aria-hidden="true" className="whitespace-nowrap text-lg font-bold leading-6 tracking-tight">
          DIVA<span className="font-medium text-yt-text-secondary"> Player</span>
        </span>
      )}
    </Link>
  );
}
