export const EXHIBITION_QUERY = 'exhibition';
export const EXHIBITION_TAB_KEY = 'diva-player:sofume-2026:tab';

export function exhibitionMode(search: string): 'booth' | 'stats' | undefined {
  const value = new URLSearchParams(search).get(EXHIBITION_QUERY);
  if (value === 'stats') return 'stats';
  if (value === '1') return 'booth';
  try {
    return window.sessionStorage.getItem(EXHIBITION_TAB_KEY) === '1' ? 'booth' : undefined;
  } catch {
    return undefined;
  }
}
