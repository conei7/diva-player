import { describe, expect, it, vi } from 'vitest';
import { RequestScheduler } from './requestScheduler';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe('RequestScheduler', () => {
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
