export const EXHIBITION_END = Date.parse('2026-11-23T00:00:00+09:00');

export function exhibitionMode(pathname: string, search: string, now = Date.now()): 'home' | 'stats' | undefined {
  if (pathname !== '/') return undefined;
  const params = new URLSearchParams(search);
  if (params.get('exhibition') === 'stats') return 'stats';
  if (now >= EXHIBITION_END || params.get('from') === 'sofume-qr' || params.has('q') || params.has('artistId')) return undefined;
  return 'home';
}
