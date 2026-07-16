import { useEffect, useState } from 'react';
import { checkBackendHealth } from '../../api/backendHealth';

const CHECK_INTERVAL_MS = 30_000;
const CHECK_TIMEOUT_MS = 5_000;

/** Shows only when SBC-only features are unavailable; normal VocaDB playback remains usable. */
export default function BackendStatusNotice() {
  const [available, setAvailable] = useState<boolean | null>(null);

  useEffect(() => {
    let active = true;

    const check = async () => {
      const healthy = await checkBackendHealth({ timeoutMs: CHECK_TIMEOUT_MS });
      if (active) setAvailable(healthy);
    };

    void check();
    const interval = window.setInterval(() => void check(), CHECK_INTERVAL_MS);
    window.addEventListener('online', check);
    return () => {
      active = false;
      window.clearInterval(interval);
      window.removeEventListener('online', check);
    };
  }, []);

  if (available !== false) return null;

  return (
    <div
      className="border-b px-4 py-2 text-sm"
      role="status"
      style={{
        background: 'color-mix(in srgb, var(--color-error) 12%, var(--color-bg-primary))',
        borderColor: 'var(--color-border)',
        color: 'var(--color-text-secondary)',
      }}
    >
      SBCのデータサービスに接続できません。通常のVocaDB検索・再生は利用できますが、詳細検索、外部再生数、人気急上昇、関連曲・推薦の一部は利用できないか簡易候補に切り替わります。
    </div>
  );
}
