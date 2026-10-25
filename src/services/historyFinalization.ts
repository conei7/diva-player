/** Small synchronous receipts let startup finish an IndexedDB write interrupted by page unload. */
import { updatePlayEventDetails, useHistoryStore } from '../stores/historyStore';
import { useProgressStore } from '../stores/progressStore';

const PREFIX = 'diva-history-finalization-';

export interface HistoryFinalization {
  id: number;
  s: number;
  t: number;
  p: number;
  d: number;
}

function valid(value: unknown): value is HistoryFinalization {
  if (!value || typeof value !== 'object') return false;
  const data = value as HistoryFinalization;
  return [data.id, data.s, data.t].every(item => Number.isSafeInteger(item) && item > 0)
    && [data.p, data.d].every(item => Number.isSafeInteger(item) && item >= 0);
}

export function rememberHistoryFinalization(value: HistoryFinalization): () => void {
  const key = `${PREFIX}${value.id}-${value.t}`;
  const raw = JSON.stringify(value);
  try { localStorage.setItem(key, raw); } catch { /* The normal IndexedDB write still runs. */ }
  return () => {
    try {
      // A more recent progress update must not be removed by an older completion.
      if (localStorage.getItem(key) === raw) localStorage.removeItem(key);
    } catch { /* Startup can retry the idempotent receipt. */ }
  };
}

export async function recoverHistoryFinalizations(
  apply = (value: HistoryFinalization) => updatePlayEventDetails(value.id, value.p, value.d, value),
): Promise<number> {
  let keys: string[];
  try {
    keys = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index))
      .filter((key): key is string => key !== null && key.startsWith(PREFIX));
  } catch { return 0; }
  let recovered = 0;
  for (const key of keys) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      const value: unknown = JSON.parse(raw);
      if (!valid(value) || key !== `${PREFIX}${value.id}-${value.t}`) continue;
      await apply(value);
      if (localStorage.getItem(key) === raw) localStorage.removeItem(key);
      recovered++;
    } catch (error) {
      // Preserve the receipt and keep the rest of the library usable on a failed recovery.
      console.error('[History] Finalization recovery failed', error);
    }
  }
  return recovered;
}

export function startHistoryFinalizationRecovery(): () => void {
  void recoverHistoryFinalizations().then(count => {
    if (count > 0) return useHistoryStore.getState().reloadHistory();
  }).catch(error => console.error('[History] Recovery failed', error));
  const onPageHide = () => {
    const { activePlayEventId: id, activeSongId: s, activePlayedAt: t } = useHistoryStore.getState();
    if (!id || !s || !t) return;
    const { progress, duration } = useProgressStore.getState();
    const d = Number.isFinite(duration) ? Math.max(0, Math.round(duration)) : 0;
    const p = Number.isFinite(progress) ? Math.max(0, Math.round(progress)) : 0;
    rememberHistoryFinalization({ id, s, t, p: d > 0 ? Math.min(p, d) : p, d });
  };
  window.addEventListener('pagehide', onPageHide);
  return () => window.removeEventListener('pagehide', onPageHide);
}
