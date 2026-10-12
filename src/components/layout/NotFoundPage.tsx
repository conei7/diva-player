import { Link } from 'react-router';
import { useTranslateSourceText } from '../../i18n';
import { buttonClassName } from '../ui/Button';
import { PageMessage } from './RouteErrorBoundary';

/**
 * Paths that match no page (old links, typos). It renders inside the frame, so the top bar,
 * the guide and the player stay; the page itself says so and offers the way home.
 * Small and not lazy: it must show even when page chunks cannot be downloaded.
 */
export default function NotFoundPage() {
  const t = useTranslateSourceText();
  return (
    <PageMessage title={t('ページが見つかりません')}>
      <Link to="/" className={buttonClassName({ variant: 'tonal' })}>{t('ホームに戻る')}</Link>
    </PageMessage>
  );
}
