import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  absoluteAppUrl,
  artistPath,
  isSearchType,
  isWatchPath,
  playlistPath,
  playlistsPath,
  searchPath,
  songShareUrl,
  watchPath,
} from './routes';

describe('routes', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('recognizes the watch page and its legacy path', () => {
    expect(isWatchPath('/watch')).toBe(true);
    expect(isWatchPath('/watch/')).toBe(true);
    expect(isWatchPath('/playing')).toBe(true);
    expect(isWatchPath('/playing/')).toBe(true);
    expect(isWatchPath('/watch-later')).toBe(false);
    expect(isWatchPath('/')).toBe(false);
    expect(isWatchPath('/playlists')).toBe(false);
  });

  it('builds watch paths with and without autoplay', () => {
    expect(watchPath(9137)).toBe('/watch?v=9137');
    expect(watchPath(9137, { autoplay: true })).toBe('/watch?v=9137');
    expect(watchPath(9137, { autoplay: false })).toBe('/watch?v=9137&autoplay=0');
  });

  it('builds playlist paths', () => {
    expect(playlistsPath()).toBe('/playlists');
    expect(playlistPath('watch-later')).toBe('/playlists?list=watch-later');
    expect(playlistPath('a b/c')).toBe('/playlists?list=a%20b%2Fc');
  });

  it('builds search paths and omits the default type', () => {
    expect(searchPath('メルト')).toBe(`/?q=${encodeURIComponent('メルト')}`);
    expect(searchPath('ryo', 'all')).toBe('/?q=ryo');
    expect(searchPath('ryo', 'producer')).toBe('/?q=ryo&type=producer');
    expect(searchPath('a&b')).toBe('/?q=a%26b');
    expect(isSearchType('vocalist')).toBe(true);
    expect(isSearchType('tag')).toBe(false);
    expect(isSearchType(null)).toBe(false);
  });

  it('builds artist paths with an optional role', () => {
    expect(artistPath({ id: 1, name: 'wowaka' })).toBe('/?artistId=1&artistName=wowaka');
    expect(artistPath({ id: 2, name: 'DECO*27' }, 'Composer'))
      .toBe('/?artistId=2&artistName=DECO*27&artistRole=Composer');
    expect(artistPath({ id: 3, name: 'A & B' })).toBe('/?artistId=3&artistName=A%20%26%20B');
  });

  it('prefixes the origin and base path for absolute URLs', () => {
    vi.stubGlobal('window', { location: { origin: 'https://example.com' } });
    const base = import.meta.env.BASE_URL.replace(/\/$/, '');
    expect(absoluteAppUrl('/watch?v=1')).toBe(`https://example.com${base}/watch?v=1`);
    expect(absoluteAppUrl('playlists')).toBe(`https://example.com${base}/playlists`);
    expect(songShareUrl(42)).toBe(`https://example.com${base}/watch?v=42`);
  });
});
