import { EXHIBITION_DAYS, type ExhibitionDay } from './exhibition';

const RECOMMENDER_API = import.meta.env.VITE_RECOMMENDER_API || '/backend-api';
const VISITS_URL = `${RECOMMENDER_API}/api/exhibition/visits`;
const VISIT_KEY = 'diva-player:sofume-2026:visit';
const registration = new Map<ExhibitionDay, Promise<number | null>>();

export type ExhibitionDailyCount = { day: ExhibitionDay; count: number };

function tabVisitId(day: ExhibitionDay): string | null {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const id = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  try {
    const saved = window.sessionStorage.getItem(VISIT_KEY);
    const previous = saved?.match(/^(2026-11-2[12]):([a-f0-9]{32})$/);
    if (previous) return previous[1] === day ? previous[2] : null;
    window.sessionStorage.setItem(VISIT_KEY, `${day}:${id}`);
  } catch {
    // In this browser the visit can still be registered for the current document.
  }
  return id;
}

async function submitVisit(day: ExhibitionDay): Promise<number | null> {
  const visitId = tabVisitId(day);
  if (!visitId) return null;
  const body = JSON.stringify({ day, visitId });
  // Retrying a transient failure uses the same identifier. Reloads also use it.
  for (const delay of [0, 1500]) {
    if (delay) await new Promise(resolve => window.setTimeout(resolve, delay));
    const response = await fetch(VISITS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: true,
      signal: AbortSignal.timeout(8000),
    }).catch(() => null);
    if (!response || response.status >= 500) continue;
    if (!response.ok) return null;
    const { ordinal } = await response.json();
    return Number.isSafeInteger(ordinal) && ordinal > 0 ? ordinal : null;
  }
  return null;
}

export function registerExhibitionVisit(day: ExhibitionDay): Promise<number | null> {
  const current = registration.get(day);
  if (current) return current;
  const request = submitVisit(day).catch(() => null);
  registration.set(day, request);
  return request;
}

export async function loadExhibitionCounts(signal: AbortSignal): Promise<ExhibitionDailyCount[]> {
  const response = await fetch(VISITS_URL, { cache: 'no-store', signal });
  if (!response.ok) throw new Error('Exhibition counts could not be loaded');
  const counts: ExhibitionDailyCount[] = await response.json();
  return EXHIBITION_DAYS.map(day => ({
    day,
    count: counts.find(record => record.day === day)?.count ?? 0,
  }));
}
