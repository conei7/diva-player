import { describe, expect, it, vi } from 'vitest';
import { RequestScheduler, scheduleFetch } from './requestScheduler';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe('RequestScheduler', () => {
  it.each([null, '', 'invalid', '61'])('does not retry an absent or unsupported quota delay: %s', async delay => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', {
      status: 429, headers: delay === null ? {} : { 'Retry-After': delay },
    }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      expect((await scheduleFetch('/backend-api/api/recommend')).status).toBe(429);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally { vi.unstubAllGlobals(); }
  });
  it('waits for a quota response and retries only once', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 429, headers: { 'Retry-After': '2' } }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const request = scheduleFetch('/backend-api/api/recommend');
      await vi.advanceTimersByTimeAsync(1999);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect((await request).status).toBe(429);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); vi.unstubAllGlobals(); }
  });

  it('cancels quota waiting without sending a retry', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 429, headers: { 'Retry-After': '60' } }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const controller = new AbortController();
      const request = scheduleFetch('/backend-api/api/recommend', { signal: controller.signal });
      const assertion = expect(request).rejects.toMatchObject({ name: 'AbortError' });
      await vi.advanceTimersByTimeAsync(0);
      controller.abort();
      await assertion;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); vi.unstubAllGlobals(); }
  });
  it('limits active work and starts foreground work before queued background work', async () => {
    const scheduler = new RequestScheduler(2, 1);
    const first = deferred<string>();
    const started: string[] = [];
    const run = (name: string, priority: 'foreground' | 'background', result = name) =>
      scheduler.run(() => { started.push(name); return name === 'first' ? first.promise : Promise.resolve(result); }, priority);

    const firstRequest = run('first', 'background');
    const queuedBackground = run('background', 'background');
    const foreground = run('foreground', 'foreground');
    await Promise.resolve();

    expect(started).toEqual(['first', 'foreground']);
    first.resolve('first');
    await Promise.all([firstRequest, queuedBackground, foreground]);
    expect(started).toEqual(['first', 'foreground', 'background']);
  });

  it('cancels queued requests without running them', async () => {
    const scheduler = new RequestScheduler(1, 1);
    const blocker = deferred<string>();
    const controller = new AbortController();
    const task = vi.fn(async () => 'late');
    const first = scheduler.run(() => blocker.promise, 'normal');
    const cancelled = scheduler.run(task, 'normal', controller.signal);
    controller.abort();

    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
    blocker.resolve('done');
    await first;
    expect(task).not.toHaveBeenCalled();
  });
});
