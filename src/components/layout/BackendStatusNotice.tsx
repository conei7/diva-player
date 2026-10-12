import { useCallback, useEffect, useRef, useState } from 'react';
import {
  checkBackendHealth,
  resolveBackendConnectivityStatus,
} from '../../api/backendHealth';
import { useTranslateSourceText } from '../../i18n';
import { showToast } from '../../stores/toastStore';
import Button from '../ui/Button';
import Popover from '../ui/Popover';
import { OfflineIcon, WarningIcon } from '../ui/icons';

const CHECK_INTERVAL_MS = 30_000;
const CHECK_TIMEOUT_MS = 5_000;

/**
 * One-line connection band under the top bar (DESIGN_SPEC §6.1.6). Offline: 「オフラインです」
 * (re-checked automatically when the browser is back online). Server unreachable:
 * 「一部の機能を利用できません」 with [詳細] (what is unavailable) and [再試行].
 * Checked every 30 seconds and on online / offline events.
 */
export default function BackendStatusNotice() {
  const t = useTranslateSourceText();
  const [available, setAvailable] = useState<boolean | null>(null);
  const [online, setOnline] = useState(() => typeof navigator === 'undefined' || navigator.onLine);
  const [checking, setChecking] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const checkInFlightRef = useRef<Promise<void> | null>(null);
  const detailsButtonRef = useRef<HTMLButtonElement>(null);
  const wasOfflineRef = useRef(false);

  const check = useCallback(async () => {
    if (checkInFlightRef.current) return checkInFlightRef.current;

    const request = (async () => {
      if (typeof navigator !== 'undefined' && !navigator.onLine) {
        setOnline(false);
        setAvailable(false);
        setChecking(false);
        return;
      }

      setOnline(true);
      setChecking(true);
      const healthy = await checkBackendHealth({ timeoutMs: CHECK_TIMEOUT_MS });
      setAvailable(healthy);
      setChecking(false);
    })();
    checkInFlightRef.current = request.finally(() => {
      checkInFlightRef.current = null;
    });
    return checkInFlightRef.current;
  }, []);

  useEffect(() => {
    let active = true;
    const runCheck = async () => {
      if (!active) return;
      await check();
    };
    const handleOnline = () => {
      setOnline(true);
      // Hide the band while the server is checked again instead of flashing the outage message.
      setAvailable(null);
      void runCheck();
    };
    const handleOffline = () => {
      setOnline(false);
      setAvailable(false);
      setChecking(false);
    };

    void runCheck();
    const interval = window.setInterval(() => void runCheck(), CHECK_INTERVAL_MS);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      active = false;
      window.clearInterval(interval);
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, [check]);

  const status = resolveBackendConnectivityStatus({ available, online });

  // Coming back from offline is announced once; the server band simply disappears when it recovers.
  useEffect(() => {
    if (status === 'offline') {
      wasOfflineRef.current = true;
    } else if (status === 'healthy' && wasOfflineRef.current) {
      wasOfflineRef.current = false;
      showToast(t('オンラインに戻りました'));
    }
  }, [status, t]);

  if (status === 'healthy' || status === 'checking') return null;

  const offline = status === 'offline';

  return (
    <div
      data-testid="backend-status-notice"
      className="flex h-10 items-center gap-3 bg-yt-tonal-solid px-4 text-sm leading-5 text-yt-text max-sm:h-9 max-sm:gap-2 max-sm:px-3"
    >
      {offline
        ? <OfflineIcon size={20} className="text-yt-text-secondary" />
        : <WarningIcon size={20} className="text-yt-warning" />}
      <span role="status" aria-live="polite" className="min-w-0 flex-1 truncate">
        {offline ? t('オフラインです') : t('一部の機能を利用できません')}
      </span>
      {!offline && (
        <div className="-mr-2 flex shrink-0 items-center">
          <Button
            ref={detailsButtonRef}
            variant="text"
            size="sm"
            aria-haspopup="dialog"
            aria-expanded={detailsOpen}
            onClick={() => setDetailsOpen(open => !open)}
          >
            {t('詳細')}
          </Button>
          <Button variant="text" size="sm" disabled={checking} onClick={() => void check()}>
            {checking ? t('確認中…') : t('再試行')}
          </Button>
          <Popover
            anchor={detailsButtonRef}
            open={detailsOpen}
            onClose={() => setDetailsOpen(false)}
            placement="bottom-end"
            width={320}
            label={t('詳細')}
          >
            {t('使えない機能: 詳細検索・再生数・急上昇・一部のおすすめ')}
          </Popover>
        </div>
      )}
    </div>
  );
}
