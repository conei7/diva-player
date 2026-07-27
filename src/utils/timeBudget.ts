export async function resolveWithin<T>(
  promise: Promise<T>,
  timeoutMs: number,
  fallback: T,
): Promise<{ value: T; timedOut: boolean }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ value: T; timedOut: boolean }>(resolve => {
    timer = setTimeout(() => resolve({ value: fallback, timedOut: true }), timeoutMs);
  });
  try {
    return await Promise.race([
      promise.then(value => ({ value, timedOut: false })),
      timeout,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
