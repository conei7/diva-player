import { useEffect, useRef, useState } from 'react';
import { useTranslate, useTranslateSourceText } from '../../i18n';
import { usePlayerStore } from '../../stores/playerStore';
import { useUiStore } from '../../stores/uiStore';
import { showToast } from '../../stores/toastStore';
import { SparkleIcon } from '../ui/iconsChrome';
import { cx } from '../ui/overlay';
import { GUIDE_ROW_CLASS, guideRowStateClass } from './navItems';

type GenerationStatus =
  | { state: 'idle' }
  | { state: 'loading' }
  | { state: 'success'; count: number };

const RESULT_VISIBLE_MS = 4000;

// The mix builder (recommendation code) is loaded on first use, not with the guide (DESIGN_SPEC §1-12).
const loadDiscoveryMix = () => import('../../services/discoveryMix');

/**
 * 「発掘ミックス」 in the guide's Explore section (DESIGN_SPEC §6.1.3): a guide row that builds a
 * queue of unheard songs and plays it right here (no navigation). The label shows
 * 「発掘中…」 and then 「{count}曲を再生中」 for 4 seconds; other outcomes are toasts.
 */
export default function DiscoveryMixButton({
  inDrawer = false,
  onStarted,
}: {
  /** Pressed in the drawer: the drawer closes, so success is also announced with a toast. */
  inDrawer?: boolean;
  onStarted?: () => void;
}) {
  const tk = useTranslate();
  const t = useTranslateSourceText();
  const [status, setStatus] = useState<GenerationStatus>({ state: 'idle' });
  const resetTimerRef = useRef<number | undefined>(undefined);
  const busyRef = useRef(false);

  useEffect(() => () => window.clearTimeout(resetTimerRef.current), []);

  const generate = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    window.clearTimeout(resetTimerRef.current);
    setStatus({ state: 'loading' });
    try {
      const { playDiscoveryMix } = await loadDiscoveryMix();
      const result = await playDiscoveryMix();
      const count = result.songs.length;
      if (count === 0) {
        setStatus({ state: 'idle' });
        showToast(tk('discoveryEmpty'), {
          action: { label: t('フィルター'), onAction: () => useUiStore.getState().openSettings('filter') },
        });
        return;
      }
      setStatus({ state: 'success', count });
      resetTimerRef.current = window.setTimeout(() => setStatus({ state: 'idle' }), RESULT_VISIBLE_MS);
      if (inDrawer) {
        showToast(count === 1 ? t('発掘ミックスを再生中（1曲）') : t('発掘ミックスを再生中（{count}曲）', { count }), {
          // Opens the queue (never closes it when it is already open).
          action: {
            label: t('キュー'),
            onAction: () => {
              const player = usePlayerStore.getState();
              if (!player.queueDrawerOpen) player.toggleQueueDrawer();
            },
          },
        });
      }
      onStarted?.();
    } catch {
      setStatus({ state: 'idle' });
      showToast(tk('discoveryError'), {
        action: { label: t('再試行'), onAction: () => void generate() },
      });
    } finally {
      busyRef.current = false;
    }
  };

  const loading = status.state === 'loading';
  const label = loading
    ? tk('discoveryLoading')
    : status.state === 'success'
      ? (status.count === 1 ? tk('discoveryPlayingOne') : tk('discoveryPlaying', { count: status.count }))
      : tk('discoveryMix');

  return (
    <button
      type="button"
      onClick={() => void generate()}
      // Warm the mix builder before the press, like the guide's page preloading.
      onPointerEnter={() => void loadDiscoveryMix().catch(() => undefined)}
      onFocus={() => void loadDiscoveryMix().catch(() => undefined)}
      aria-label={tk('discoveryAria')}
      aria-busy={loading || undefined}
      className={cx(GUIDE_ROW_CLASS, guideRowStateClass(false), loading ? 'cursor-progress' : 'cursor-pointer')}
    >
      <SparkleIcon className={loading ? 'animate-spin motion-reduce:animate-none' : undefined} />
      <span className="min-w-0 flex-1 truncate" aria-live="polite">{label}</span>
    </button>
  );
}
