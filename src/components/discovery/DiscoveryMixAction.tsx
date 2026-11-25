import { useRef, useState } from 'react';
import { useTranslate, useTranslateSourceText } from '../../i18n';
import { playDiscoveryMixWithNotice } from '../../services/discoveryMix';
import { useLanguageStore } from '../../stores/languageStore';
import { showToast } from '../../stores/toastStore';
import Button from '../ui/Button';
import { SparkleIcon } from '../ui/icons';

/**
 * White pill that builds a discovery mix and starts it without leaving the page. The toasts are
 * the guide's 「発掘ミックス」 ones (DiscoveryMixButton): 1 / n songs with 「キュー」, none with 「フィルター」.
 */
export default function DiscoveryMixAction() {
  const tk = useTranslate();
  const t = useTranslateSourceText();
  const language = useLanguageStore(state => state.language);
  const [loading, setLoading] = useState(false);
  const runningRef = useRef(false);

  const run = async () => {
    if (runningRef.current) return;
    runningRef.current = true;
    setLoading(true);
    try {
      await playDiscoveryMixWithNotice(language, true);
    } catch {
      showToast(tk('discoveryError'), { action: { label: t('再試行'), onAction: () => void run() } });
    } finally {
      runningRef.current = false;
      setLoading(false);
    }
  };

  return (
    <Button variant="primary" icon={<SparkleIcon />} loading={loading} onClick={() => void run()}>
      {tk('discoveryAria')}
    </Button>
  );
}
