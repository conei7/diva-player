export interface ViewHistoryData {
  date: string;
  youtube: number | null;
  nico: number | null;
  correctedYoutube?: boolean;
  correctedNico?: boolean;
}

export type ViewHistoryRange = '7d' | '30d' | '90d' | 'all';

export function filterViewHistoryByRange(
  history: ViewHistoryData[],
  range: ViewHistoryRange,
): ViewHistoryData[] {
  if (range === 'all' || history.length === 0) return history;
  const latest = Date.parse(`${history[history.length - 1].date}T00:00:00Z`);
  const days = Number(range.slice(0, -1));
  const cutoff = latest - (days - 1) * 24 * 60 * 60 * 1000;
  return history.filter(item => Date.parse(`${item.date}T00:00:00Z`) >= cutoff);
}

function normalizeDateKey(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value);
  const isoDate = text.match(/^\d{4}-\d{2}-\d{2}/)?.[0];
  if (isoDate) return isoDate;
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

function toViewCount(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const numeric = typeof value === 'number' ? value : Number(value ?? 0);
  return Number.isFinite(numeric) && numeric >= 0 ? Math.round(numeric) : null;
}

export function normalizeViewHistory(history: unknown[]): ViewHistoryData[] {
  const daily = new Map<string, ViewHistoryData>();
  for (const item of history) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Partial<Record<keyof ViewHistoryData, unknown>>;
    const date = normalizeDateKey(row.date);
    if (!date) continue;
    const youtube = toViewCount(row.youtube);
    const nico = toViewCount(row.nico);
    const current = daily.get(date) ?? { date, youtube: null, nico: null };
    daily.set(date, {
      date,
      youtube: youtube === null ? current.youtube : Math.max(current.youtube ?? 0, youtube),
      nico: nico === null ? current.nico : Math.max(current.nico ?? 0, nico),
    });
  }
  const sorted = [...daily.values()].sort((a, b) => a.date.localeCompare(b.date));
  for (const service of ['youtube', 'nico'] as const) {
    let previous: number | null = null;
    for (let index = 0; index < sorted.length; index += 1) {
      const current = sorted[index][service];
      if (current === null) continue;
      const next = sorted[index + 1]?.[service] ?? null;
      if (previous === null && current === 0) {
        sorted[index][service] = null;
        continue;
      }
      const isolatedDrop = previous !== null && current < previous && next !== null && next >= previous * 0.98;
      const isolatedSpike = previous !== null && next !== null && current > previous * 2 + 1000 && next < current * 0.5;
      if (isolatedDrop || isolatedSpike) {
        sorted[index][service] = Math.max(previous ?? 0, next ?? 0);
        sorted[index][service === 'youtube' ? 'correctedYoutube' : 'correctedNico'] = true;
      }
      previous = sorted[index][service];
    }
  }
  return sorted;
}
