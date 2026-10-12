import { useRef, useState } from 'react';
import { useTranslate, useTranslateSourceText } from '../../i18n';
import { playDiscoveryMix } from '../../services/discoveryMix';
import { usePlayerStore } from '../../stores/playerStore';
import { showToast } from '../../stores/toastStore';
import { useUiStore } from '../../stores/uiStore';
import Button from '../ui/Button';
import { SparkleIcon } from '../ui/icons';

function openQueue() {
  const player = usePlayerStore.getState();
  if (!player.queueDrawerOpen) player.toggleQueueDrawer();
}

/**
 * White pill that builds a discovery mix and starts it without leaving the page. The toasts are
 * the guide's 「発掘ミックス」 ones (DiscoveryMixButton): 1 / n songs with 「キュー」, none with 「フィルター」.
 */
export default function DiscoveryMixAction() {
  const tk = useTranslate();
  const t = useTranslateSourceText();
  const [loading, setLoading] = useState(false);
  const runningRef = useRef(false);

  const run = async () => {
    if (runningRef.current) return;
    runningRef.current = true;
    setLoading(true);
    try {
      const count = (await playDiscoveryMix()).songs.length;
      if (count === 0) {
        showToast(tk('discoveryEmpty'), {
          action: { label: t('フィルター'), onAction: () => useUiStore.getState().openSettings('filter') },
        });
      } else {
        showToast(count === 1 ? t('発掘ミックスを再生中（1曲）') : t('発掘ミックスを再生中（{count}曲）', { count }), {
          action: { label: t('キュー'), onAction: openQueue },
        });
      }
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
