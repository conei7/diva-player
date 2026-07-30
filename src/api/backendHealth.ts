export interface BackendHealthOptions {
  baseUrl?: string;
  timeoutMs?: number;
  attempts?: number;
  retryDelayMs?: number;
  fetchImpl?: typeof fetch;
}

export type BackendConnectivityStatus = 'checking' | 'healthy' | 'offline' | 'unavailable';

// /api/health includes the actionable audio-feature boundary, which may take
// several seconds on a cold PostgreSQL cache. Keep the client from declaring
// the backend unavailable before that legitimate health response arrives.
const DEFAULT_HEALTH_TIMEOUT_MS = 20_000;

export function resolveBackendConnectivityStatus({
  available,
  online,
}: {
  available: boolean | null;
  online: boolean;
}): BackendConnectivityStatus {
  if (!online) return 'offline';
  if (available === null) return 'checking';
  return available ? 'healthy' : 'unavailable';
}

const wait = (delayMs: number) => new Promise(resolve => setTimeout(resolve, delayMs));

export async function checkBackendHealth({
  baseUrl = '/backend-api',
  timeoutMs = DEFAULT_HEALTH_TIMEOUT_MS,
  attempts = 2,
  retryDelayMs = 400,
  fetchImpl = fetch,
}: BackendHealthOptions = {}): Promise<boolean> {
  const normalizedBaseUrl = baseUrl.replace(/\/$/, '');
  const normalizedAttempts = Math.max(1, Math.floor(attempts));

  for (let attempt = 0; attempt < normalizedAttempts; attempt += 1) {
    try {
      const response = await fetchImpl(`${normalizedBaseUrl}/api/health`, {
        cache: 'no-store',
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.ok) return true;
    } catch {
      // A transient tunnel or network failure is retried below.
    }

    if (attempt + 1 < normalizedAttempts && retryDelayMs > 0) {
      await wait(retryDelayMs);
    }
  }

  return false;
}
