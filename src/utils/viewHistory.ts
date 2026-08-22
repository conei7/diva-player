export interface ViewHistoryData {
  date: string;
  youtube: number | null;
  nico: number | null;
  correctedYoutube?: boolean;
  correctedNico?: boolean;
  baseline?: boolean;
}

export type ViewHistoryRange = '7d' | '30d' | '90d' | 'all';
export type ViewHistoryBucket = 'day' | 'week' | 'month';
export type ViewHistoryMetric = 'cumulative' | 'growth';

export interface ViewHistoryYAxisRange {
  yMin: number;
  yMax: number;
}

export function formatExactViewCount(value: number): string {
  return Math.round(value).toLocaleString('ja-JP');
}

/** Returns measured points only; cumulative charts connect across temporary collection gaps. */
export function getObservedViewHistory(
  history: readonly ViewHistoryData[],
  service: 'youtube' | 'nico',
): ViewHistoryData[] {
  return history.filter(item => item[service] !== null);
}

export function getViewHistoryYAxisRange(
  history: ViewHistoryData[],
  metric: ViewHistoryMetric,
): ViewHistoryYAxisRange {
  const values = history.flatMap(item => [item.youtube, item.nico]
    .filter((value): value is number => value !== null && Number.isFinite(value)));
  const maxValue = Math.max(...values, 0);
  if (metric === 'growth' && values.some(value => value < 0)) {
    return {
      yMin: -Math.max(...values.map(value => Math.abs(value)), 0),
      yMax: Math.max(...values.map(value => Math.abs(value)), 0),
    };
  }
  return { yMin: 0, yMax: maxValue };
}

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

export function bucketForViewHistoryRange(range: ViewHistoryRange): ViewHistoryBucket {
  if (range === '90d') return 'week';
  if (range === 'all') return 'month';
  return 'day';
}

function bucketKey(date: string, bucket: ViewHistoryBucket): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return date;
  if (bucket === 'month') return date.slice(0, 7);
  if (bucket === 'week') {
    const day = parsed.getUTCDay();
    const mondayOffset = day === 0 ? -6 : 1 - day;
    parsed.setUTCDate(parsed.getUTCDate() + mondayOffset);
    return parsed.toISOString().slice(0, 10);
  }
  return date;
}

/** Keeps the last observation in each display bucket while preserving missing series. */
export function aggregateViewHistory(
  history: ViewHistoryData[],
  bucket: ViewHistoryBucket,
): ViewHistoryData[] {
  const grouped = new Map<string, ViewHistoryData>();
  for (const item of history) {
    if (item.baseline) continue;
    const key = bucketKey(item.date, bucket);
    const previous = grouped.get(key);
    grouped.set(key, {
      date: item.date,
      youtube: item.youtube ?? previous?.youtube ?? null,
      nico: item.nico ?? previous?.nico ?? null,
      correctedYoutube: Boolean(item.correctedYoutube || previous?.correctedYoutube),
      correctedNico: Boolean(item.correctedNico || previous?.correctedNico),
    });
  }
  return [...grouped.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/** Converts cumulative snapshots into per-bucket changes. Negative changes remain visible. */
export function toGrowthViewHistory(
  history: ViewHistoryData[],
  baseline?: ViewHistoryData | null,
  bucket: ViewHistoryBucket = 'day',
): ViewHistoryData[] {
  const sorted = history.filter(item => !item.baseline).sort((a, b) => a.date.localeCompare(b.date));
  const explicitBaseline = baseline ?? history.find(item => item.baseline) ?? null;
  let previousYoutube = explicitBaseline?.youtube ?? null;
  let previousNico = explicitBaseline?.nico ?? null;
  let previousYoutubeDate = previousYoutube === null ? null : explicitBaseline?.date ?? null;
  let previousNicoDate = previousNico === null ? null : explicitBaseline?.date ?? null;

  const isAdjacentBucket = (previousDate: string | null, currentDate: string): boolean => {
    if (!previousDate) return false;
    const previous = new Date(`${previousDate}T00:00:00Z`);
    const current = new Date(`${currentDate}T00:00:00Z`);
    if (Number.isNaN(previous.getTime()) || Number.isNaN(current.getTime())) return false;
    if (bucket === 'month') {
      previous.setUTCMonth(previous.getUTCMonth() + 1);
      return previous.getUTCFullYear() === current.getUTCFullYear()
        && previous.getUTCMonth() === current.getUTCMonth();
    }
    const expectedDays = bucket === 'week' ? 7 : 1;
    return current.getTime() - previous.getTime() === expectedDays * 24 * 60 * 60 * 1000;
  };

  return sorted.map(item => {
    const youtube = item.youtube === null || previousYoutube === null || !isAdjacentBucket(previousYoutubeDate, item.date)
      ? null
      : item.youtube - previousYoutube;
    const nico = item.nico === null || previousNico === null || !isAdjacentBucket(previousNicoDate, item.date)
      ? null
      : item.nico - previousNico;
    if (item.youtube !== null) {
      previousYoutube = item.youtube;
      previousYoutubeDate = item.date;
    }
    if (item.nico !== null) {
      previousNico = item.nico;
      previousNicoDate = item.date;
    }
    return {
      date: item.date,
      youtube,
      nico,
      correctedYoutube: item.correctedYoutube,
      correctedNico: item.correctedNico,
    };
  });
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
      baseline: Boolean(current.baseline || row.baseline === true),
    });
  }
  const sorted = [...daily.values()].sort((a, b) => a.date.localeCompare(b.date));
  return sorted;
}
