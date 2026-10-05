export type RequestPriority = 'foreground' | 'normal' | 'background';

interface QueuedRequest<T> {
  priority: RequestPriority;
  sequence: number;
  signal?: AbortSignal;
  task: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
  abortHandler?: () => void;
}

/** Keeps background prefetches from occupying every API connection. */
export class RequestScheduler {
  private readonly queue: QueuedRequest<unknown>[] = [];
  private active = 0;
  private activeBackground = 0;
  private sequence = 0;
  private readonly maxConcurrent: number;
  private readonly maxBackground: number;

  constructor(maxConcurrent = 2, maxBackground = 1) {
    this.maxConcurrent = maxConcurrent;
    this.maxBackground = maxBackground;
  }

  run<T>(
    task: () => Promise<T>,
    priority: RequestPriority = 'normal',
    signal?: AbortSignal,
  ): Promise<T> {
    if (signal?.aborted) return Promise.reject(new DOMException('Request was aborted', 'AbortError'));

    return new Promise<T>((resolve, reject) => {
      const request: QueuedRequest<T> = {
        priority,
        sequence: this.sequence++,
        signal,
        task,
        resolve,
        reject,
      };
      if (signal) {
        request.abortHandler = () => {
          const index = this.queue.indexOf(request as QueuedRequest<unknown>);
          if (index < 0) return;
          this.queue.splice(index, 1);
          reject(new DOMException('Request was aborted', 'AbortError'));
          this.pump();
        };
        signal.addEventListener('abort', request.abortHandler, { once: true });
      }
      this.queue.push(request as QueuedRequest<unknown>);
      this.pump();
    });
  }

  private pump(): void {
    while (this.active < this.maxConcurrent) {
      this.queue.sort((left, right) => this.rank(left.priority) - this.rank(right.priority)
        || left.sequence - right.sequence);
      const index = this.queue.findIndex(request => (
        !request.signal?.aborted
        && (request.priority !== 'background' || this.activeBackground < this.maxBackground)
      ));
      if (index < 0) return;

      const request = this.queue.splice(index, 1)[0];
      if (request.abortHandler) request.signal?.removeEventListener('abort', request.abortHandler);
      this.active++;
      if (request.priority === 'background') this.activeBackground++;
      void Promise.resolve().then(request.task).then(request.resolve, request.reject).finally(() => {
        this.active--;
        if (request.priority === 'background') this.activeBackground--;
        this.pump();
      });
    }
  }

  private rank(priority: RequestPriority): number {
    return priority === 'foreground' ? 0 : priority === 'normal' ? 1 : 2;
  }
}

export const apiRequestScheduler = new RequestScheduler(2, 1);

export function scheduleFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
  priority: RequestPriority = 'normal',
): Promise<Response> {
  return apiRequestScheduler.run(() => fetch(input, init), priority, init?.signal ?? undefined);
}
