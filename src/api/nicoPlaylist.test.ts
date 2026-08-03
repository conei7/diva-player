import { describe, expect, it } from 'vitest';
import { extractNicoPlaylistSource, normalizeNicoPlaylistUrl } from './nicoPlaylist';

describe('NicoNico playlist URL handling', () => {
  it('accepts public mylist and series URLs', () => {
    expect(extractNicoPlaylistSource('https://www.nicovideo.jp/mylist/26375614')).toEqual({ kind: 'mylist', id: '26375614' });
    expect(extractNicoPlaylistSource('https://sp.nicovideo.jp/series/359827?ref=x')).toEqual({ kind: 'series', id: '359827' });
    expect(extractNicoPlaylistSource('mylist:26375614')).toEqual({ kind: 'mylist', id: '26375614' });
  });

  it('rejects video URLs and lookalike hosts', () => {
    expect(extractNicoPlaylistSource('https://www.nicovideo.jp/watch/sm9')).toBeNull();
    expect(extractNicoPlaylistSource('https://nicovideo.jp.example.com/mylist/1')).toBeNull();
  });

  it('normalizes the public URL', () => {
    expect(normalizeNicoPlaylistUrl({ kind: 'series', id: '359827' })).toBe('https://www.nicovideo.jp/series/359827');
  });
});
