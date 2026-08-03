import { compactRecommendationHint } from '../../utils/recommendationDisplayPreferences';

interface RecommendationHintProps {
  reason: string;
  className?: string;
}

export default function RecommendationHint({ reason, className = '' }: RecommendationHintProps) {
  return (
    <span
      className={`inline-flex max-w-full items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${className}`}
      style={{ background: 'rgba(6, 214, 160, 0.10)', color: 'var(--color-accent-cyan)' }}
      title={reason}
    >
      <svg className="flex-shrink-0" width="9" height="9" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="m12 2 1.55 5.45L19 9l-5.45 1.55L12 16l-1.55-5.45L5 9l5.45-1.55L12 2Zm7 12 .86 3.14L23 18l-3.14.86L19 22l-.86-3.14L15 18l3.14-.86L19 14Z" />
      </svg>
      <span className="truncate">{compactRecommendationHint(reason)}</span>
    </span>
  );
}
