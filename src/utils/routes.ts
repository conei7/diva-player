/**
 * App-internal paths. Every link and navigate() call should build its URL here
 * so the URL contract (DESIGN_SPEC §5.1) stays in one place.
 * Paths are router paths (without BASE_URL); use absoluteAppUrl() for links
 * that leave the app (share, clipboard).
 */

export type SearchType = 'all' | 'song' | 'producer' | 'vocalist';

export const SEARCH_TYPES: readonly SearchType[] = ['all', 'song', 'producer', 'vocalist'];

export function isSearchType(value: string | null | undefined): value is SearchType {
  return value === 'all' || value === 'song' || value === 'producer' || value === 'vocalist';
}

/** '/watch' and the legacy '/playing' (a trailing slash is allowed). */
export function isWatchPath(pathname: string): boolean {
  return /^\/(?:watch|playing)\/?$/.test(pathname);
}

/** '/watch?v=ID'. `autoplay: false` adds '&autoplay=0' (links that open in a new tab). */
export function watchPath(songId: number, options: { autoplay?: boolean } = {}): string {
  const base = `/watch?v=${encodeURIComponent(String(songId))}`;
  return options.autoplay === false ? `${base}&autoplay=0` : base;
}

export function playlistsPath(): string {
  return '/playlists';
}

export function playlistPath(id: string): string {
  return `/playlists?list=${encodeURIComponent(id)}`;
}

/** '/?q=<q>' and '&type=<type>' unless the type is 'all'. */
export function searchPath(q: string, type: SearchType = 'all'): string {
  const base = `/?q=${encodeURIComponent(q)}`;
  return type === 'all' ? base : `${base}&type=${type}`;
}

/** Song list of one artist: '/?artistId=..&artistName=..(&artistRole=..)'. */
export function artistPath(artist: { id: number; name: string }, role?: string): string {
  const base = `/?artistId=${encodeURIComponent(String(artist.id))}&artistName=${encodeURIComponent(artist.name)}`;
  return role ? `${base}&artistRole=${encodeURIComponent(role)}` : base;
}

/** origin + BASE_URL (without its trailing slash) + path. */
export function absoluteAppUrl(path: string): string {
  const origin = typeof window === 'undefined' ? '' : window.location.origin;
  const basePath = (import.meta.env.BASE_URL ?? '/').replace(/\/$/, '');
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${origin}${basePath}${normalizedPath}`;
}

export function songShareUrl(songId: number): string {
  return absoluteAppUrl(watchPath(songId));
}
