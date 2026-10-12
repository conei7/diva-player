import { describe, expect, it } from 'vitest';
import { activeNavId, compactNavId, isPlainLeftClick, isSearchResultsLocation, navTargetOf, toNavLocation } from './navItems';

describe('activeNavId', () => {
  it('selects the destination of the current path', () => {
    expect(activeNavId({ pathname: '/', search: '' })).toBe('home');
    expect(activeNavId({ pathname: '/history', search: '' })).toBe('history');
    expect(activeNavId({ pathname: '/history/', search: '' })).toBe('history');
    expect(activeNavId({ pathname: '/settings/hidden-songs', search: '' })).toBe('hiddenSongs');
  });

  it('tells Listen later apart from the other playlists', () => {
    expect(activeNavId({ pathname: '/playlists', search: '' })).toBe('playlists');
    expect(activeNavId({ pathname: '/playlists', search: '?list=seed-bgm' })).toBe('playlists');
    expect(activeNavId({ pathname: '/playlists', search: '?list=watch-later' })).toBe('watchLater');
  });

  it('selects nothing on pages outside the guide', () => {
    expect(activeNavId({ pathname: '/watch', search: '?v=1' })).toBeNull();
    expect(activeNavId({ pathname: '/no-such-page', search: '' })).toBeNull();
  });

  it('selects nothing on search results and artist pages (they are not the home feed)', () => {
    expect(activeNavId({ pathname: '/', search: '?q=wowaka' })).toBeNull();
    expect(activeNavId({ pathname: '/', search: '?q=wowaka&type=producer' })).toBeNull();
    expect(activeNavId({ pathname: '/', search: '?artistId=45&artistName=x' })).toBeNull();
    expect(activeNavId({ pathname: '/', search: '', state: { divaAdvancedSearch: true } })).toBeNull();
  });

  it('keeps Home selected when the URL only looks like a search', () => {
    expect(activeNavId({ pathname: '/', search: '?q=' })).toBe('home');
    expect(activeNavId({ pathname: '/', search: '?q=%20' })).toBe('home');
    expect(activeNavId({ pathname: '/', search: '?artistId=abc' })).toBe('home');
    expect(activeNavId({ pathname: '/', search: '?artistId=0' })).toBe('home');
    expect(activeNavId({ pathname: '/', search: '', state: { divaAdvancedSearch: false } })).toBe('home');
    expect(activeNavId({ pathname: '/', search: '', state: null })).toBe('home');
  });
});

describe('isSearchResultsLocation', () => {
  it('only applies to the home path', () => {
    expect(isSearchResultsLocation({ pathname: '/', search: '?q=wowaka' })).toBe(true);
    expect(isSearchResultsLocation({ pathname: '/history', search: '?q=wowaka' })).toBe(false);
  });
});

describe('compactNavId', () => {
  it('shows Listen later as Playlists where it has no item of its own', () => {
    expect(compactNavId('watchLater')).toBe('playlists');
    expect(compactNavId('playlists')).toBe('playlists');
    expect(compactNavId('history')).toBe('history');
    expect(compactNavId(null)).toBeNull();
  });
});

describe('navigation targets', () => {
  it('splits and joins path and search', () => {
    expect(toNavLocation('/playlists?list=watch-later')).toEqual({ pathname: '/playlists', search: '?list=watch-later' });
    expect(toNavLocation('/history')).toEqual({ pathname: '/history', search: '' });
    expect(navTargetOf({ pathname: '/history/', search: '' })).toBe('/history');
    expect(navTargetOf({ pathname: '/playlists', search: '?list=a' })).toBe('/playlists?list=a');
  });

  it('only treats plain left clicks as in-app navigation', () => {
    const click = { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, defaultPrevented: false };
    expect(isPlainLeftClick(click)).toBe(true);
    expect(isPlainLeftClick({ ...click, ctrlKey: true })).toBe(false);
    expect(isPlainLeftClick({ ...click, button: 1 })).toBe(false);
    expect(isPlainLeftClick({ ...click, defaultPrevented: true })).toBe(false);
  });
});
