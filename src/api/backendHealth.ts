export interface BackendHealthOptions {
  baseUrl?: string;
  timeoutMs?: number;
  attempts?: number;
  retryDelayMs?: number;
  fetchImpl?: typeof fetch;
}

const wait = (delayMs: number) => new Promise(resolve => setTimeout(resolve, delayMs));

export async function checkBackendHealth({
  baseUrl = '/backend-api',
  timeoutMs = 5_000,
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
