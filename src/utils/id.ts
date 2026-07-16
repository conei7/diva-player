let fallbackCounter = 0;

/** Generates an ID in secure contexts and also works on plain HTTP pages. */
export function createStableId(prefix = 'id'): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  fallbackCounter = (fallbackCounter + 1) % 1_000_000;
  return `${prefix}-${Date.now().toString(36)}-${fallbackCounter.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
