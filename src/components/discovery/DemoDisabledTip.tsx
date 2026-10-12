import type { ReactElement } from 'react';
import { useTranslateSourceText } from '../../i18n';
import Tooltip from '../ui/Tooltip';

/**
 * Wraps a control that the local demo / pilot map can't use. Disabled buttons get no pointer
 * events, so the tooltip 「デモでは使えません」 hangs from a wrapper span instead.
 */
export default function DemoDisabledTip({ disabled, children }: { disabled: boolean; children: ReactElement }) {
  const t = useTranslateSourceText();
  if (!disabled) return children;
  return (
    <Tooltip content={t('デモでは使えません')}>
      <span className="inline-flex [&>button]:pointer-events-none">{children}</span>
    </Tooltip>
  );
}
