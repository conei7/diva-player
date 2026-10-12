import type { MouseEvent } from 'react';
import { useTranslateSourceText } from '../../i18n';
import IconButton from '../ui/IconButton';
import { VolumeOffIcon } from '../ui/icons';
import { cx } from '../ui/overlay';
import { unmutePlayer } from './playerMute';

interface MuteBadgeProps {
  /** 8px from the corner on the mini player, 12px on the song page. */
  inset: 'mini' | 'page';
  /** Called after unmuting from the badge, while the badge still has the focus it was pressed with. */
  onUnmuted?: (badgeHadFocus: boolean) => void;
}

/**
 * The badge on the video's top-left corner while nothing can be heard (muted with M, or a volume of
 * 0). It is the only sign of silence in the app, so it shows on the mini player and the song page
 * alike; pressing it unmutes. Loaded on demand (outside the initial JavaScript).
 */
export default function MuteBadge({ inset, onUnmuted }: MuteBadgeProps) {
  const t = useTranslateSourceText();
  const unmute = (event: MouseEvent<HTMLButtonElement>) => {
    const badgeHadFocus = event.currentTarget === document.activeElement;
    unmutePlayer();
    onUnmuted?.(badgeHadFocus);
  };
  return (
    <div className={cx('absolute z-[1]', inset === 'page' ? 'left-3 top-3' : 'left-2 top-2')}>
      <IconButton
        variant="overlay"
        label={t('ミュートを解除')}
        icon={<VolumeOffIcon />}
        data-testid="player-mute-badge"
        onClick={unmute}
      />
    </div>
  );
}
