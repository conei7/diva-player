import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  checkBackendHealth,
  resolveBackendConnectivityStatus,
  type BackendConnectivityStatus,
} from '../../api/backendHealth';

const CHECK_INTERVAL_MS = 30_000;
const CHECK_TIMEOUT_MS = 5_000;

const STATUS_COPY: Record<Exclude<BackendConnectivityStatus, 'healthy' | 'checking'>, {
  title: string;
  message: string;
  background: string;
  color: string;
}> = {
  offline: {
    title: 'オフラインモードです',
    message: 'ブラウザがオフラインのため、SBCのデータサービスを利用できません。保存済みプレイリスト・履歴・評価は引き続き利用できます。',
    background: 'color-mix(in srgb, #fbbf24 12%, var(--color-bg-primary))',
    color: '#fbbf24',
  },
  unavailable: {
    title: 'SBCのデータサービスに接続できません',
    message: '通常のVocaDB検索・再生と保存済みプレイリスト・履歴・評価は利用できます。詳細検索、外部再生数、人気急上昇、関連曲・推薦の一部は利用できないか簡易候補に切り替わります。',
    background: 'color-mix(in srgb, var(--color-error) 12%, var(--color-bg-primary))',
    color: 'var(--color-text-secondary)',
  },
};

/** Keeps local playback and saved data discoverable while SBC-only features degrade. */
export default function BackendStatusNotice() {
  const [available, setAvailable] = useState<boolean | null>(null);
  const [online, setOnline] = useState(() => typeof navigator === 'undefined' || navigator.onLine);
  const [checking, setChecking] = useState(false);

  const check = useCallback(async () => {
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
  }, []);

  useEffect(() => {
    let active = true;
    const runCheck = async () => {
      if (!active) return;
      await check();
    };
    const handleOnline = () => {
      setOnline(true);
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
  if (status === 'healthy' || status === 'checking') return null;

  const copy = STATUS_COPY[status];
  return (
    <div
      className="border-b px-4 py-2.5 text-sm"
      role="status"
      aria-live="polite"
      style={{
        background: copy.background,
        borderColor: 'var(--color-border)',
        color: copy.color,
      }}
    >
      <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1">
          <p className="font-semibold" style={{ color: copy.color }}>{copy.title}</p>
          <p className="mt-0.5 text-xs leading-5" style={{ color: 'var(--color-text-secondary)' }}>{copy.message}</p>
          <nav className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-xs" aria-label="利用可能なローカル機能">
            <Link className="underline decoration-dotted underline-offset-2" to="/playlists">プレイリスト</Link>
            <Link className="underline decoration-dotted underline-offset-2" to="/history">履歴</Link>
            <Link className="underline decoration-dotted underline-offset-2" to="/favorites">評価・お気に入り</Link>
          </nav>
        </div>
        <button
          type="button"
          onClick={() => void check()}
          disabled={checking || status === 'offline'}
          className="shrink-0 rounded-lg border border-white/20 px-3 py-1.5 text-xs font-semibold transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {checking ? '再確認中…' : '再接続を確認'}
        </button>
      </div>
    </div>
  );
}
