import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchGroupSoundMap, SoundMapRequestError } from './soundMap';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('group map catalogue polling', () => {
  it('polls preparing once and sends group plus viewport without full vectors', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn().mockResolvedValueOnce(new Response('{"state":"preparing"}', { status: 202 }))
      .mockResolvedValueOnce(new Response('{"method":"group_feature_axes"}'));
    vi.stubGlobal('fetch', fetcher);
    const controller = new AbortController();
    const request = fetchGroupSoundMap([1, 2, 3], { signal: controller.signal, viewport: { centerX: .1, centerY: -.2, zoom: 128 } });
    await vi.advanceTimersByTimeAsync(2000);
    expect((await request).method).toBe('group_feature_axes');
    expect(fetcher).toHaveBeenCalledTimes(2);
    const url = new URL(fetcher.mock.calls[0][0], 'https://example.test');
    expect(url.searchParams.get('songIds')).toBe('1,2,3');
    expect(url.searchParams.get('zoom')).toBe('128');
  });

  it('cancels the delay when leaving so no further polling occurs', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn().mockResolvedValue(new Response('{}', { status: 202 }));
    vi.stubGlobal('fetch', fetcher);
    const controller = new AbortController();
    const request = fetchGroupSoundMap([1, 2, 3], { signal: controller.signal });
    const rejection = expect(request).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await rejection;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('reports unavailable song IDs without dropping songs or retrying the error', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('{"error":"group_songs_unavailable","songIds":[2]}', { status: 422 }));
    vi.stubGlobal('fetch', fetcher);
    await expect(fetchGroupSoundMap([1, 2, 3], { signal: new AbortController().signal })).rejects.toEqual(
      expect.objectContaining<Partial<SoundMapRequestError>>({ code: 'group_songs_unavailable', message: '2', status: 422 }));
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
