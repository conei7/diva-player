import { describe, expect, it } from 'vitest';
import { isCurrentWatchSongRequest, watchUrlPlaybackTarget } from './watchNavigation';

describe('watch navigation race guards', () => {
  it('rejects a late response from the previously selected song', () => {
    expect(isCurrentWatchSongRequest(1, 2, 100, 200)).toBe(false);
    expect(isCurrentWatchSongRequest(2, 2, 200, 200)).toBe(true);
  });

  it('does not redirect to the previous song while the selected URL is loading', () => {
    expect(watchUrlPlaybackTarget({
      requestedSongId: 200,
      displayedSongId: null,
      playingSongId: 100,
      loadingFromUrl: true,
    })).toBeNull();
  });

  it('syncs the URL after the committed song advances naturally', () => {
    expect(watchUrlPlaybackTarget({
      requestedSongId: 200,
      displayedSongId: 200,
      playingSongId: 300,
      loadingFromUrl: false,
    })).toBe(300);
  });
});
