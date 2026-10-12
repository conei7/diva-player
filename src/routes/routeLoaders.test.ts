import { describe, expect, it } from 'vitest';
import { routeKeyForPath } from './routeLoaders';

describe('routeKeyForPath', () => {
  it('maps router paths (with search or a trailing slash) to page chunks', () => {
    expect(routeKeyForPath('/')).toBe('home');
    expect(routeKeyForPath('/?q=wowaka')).toBe('home');
    expect(routeKeyForPath('/watch?v=1501')).toBe('watch');
    expect(routeKeyForPath('/playing?v=1501')).toBe('watch');
    expect(routeKeyForPath('/playlists?list=watch-later')).toBe('playlists');
    expect(routeKeyForPath('/history/')).toBe('history');
    expect(routeKeyForPath('/settings/hidden-songs')).toBe('hiddenSongs');
    expect(routeKeyForPath('/knowledge-map#top')).toBe('knowledgeMap');
  });

  it('returns null for unknown paths', () => {
    expect(routeKeyForPath('/nope')).toBeNull();
    expect(routeKeyForPath('/settings')).toBeNull();
  });
});
