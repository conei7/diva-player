import { useTranslateSourceText } from '../../i18n';
import Tooltip from '../ui/Tooltip';
import { cx } from '../ui/overlay';
import { fullRecommendationReason, shortRecommendationReason } from './reasonLabels';

interface RecommendationHintProps {
  reason: string;
  className?: string;
}

/** Why a song was recommended, as a short line of secondary text (「音が近い」など). */
export default function RecommendationHint({ reason, className = '' }: RecommendationHintProps) {
  const t = useTranslateSourceText();
  const label = t(shortRecommendationReason(reason));
  const fullReason = t(fullRecommendationReason(reason));
  const text = (
    <span className={cx('block max-w-full truncate text-xs leading-[18px] text-yt-text-secondary', className)}>
      {label}
    </span>
  );
  // The full sentence is only worth a tooltip when the short label left something out.
  return fullReason === label ? text : <Tooltip content={fullReason}>{text}</Tooltip>;
}
