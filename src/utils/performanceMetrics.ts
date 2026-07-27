export interface PerformanceSegment {
  name: string;
  durationMs: number;
}

export interface DivaPerformanceMetric {
  name: string;
  startedAt: number;
  durationMs: number;
  segments: PerformanceSegment[];
  detail?: Record<string, string | number | boolean | undefined>;
  recordedAt: string;
}

const MAX_METRICS = 100;
const metrics: DivaPerformanceMetric[] = [];

export function performanceNow(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

export function parseServerTiming(header: string | null): PerformanceSegment[] {
  if (!header) return [];
  return header.split(',').flatMap(value => {
    const [rawName, ...parameters] = value.trim().split(';');
    const durationParameter = parameters.find(parameter => parameter.trim().startsWith('dur='));
    if (!rawName || !durationParameter) return [];
    const durationMs = Number(durationParameter.trim().slice(4).replace(/^"|"$/g, ''));
    return Number.isFinite(durationMs) ? [{ name: `server.${rawName}`, durationMs }] : [];
  });
}

function performanceDebugEnabled(): boolean {
  try {
    if (typeof location !== 'undefined' && new URLSearchParams(location.search).get('perf') === '1') return true;
    return typeof localStorage !== 'undefined' && localStorage.getItem('diva-performance-debug') === '1';
  } catch {
    return false;
  }
}

export function recordPerformanceMetric(input: {
  name: string;
  startedAt: number;
  segments?: PerformanceSegment[];
  detail?: DivaPerformanceMetric['detail'];
}): DivaPerformanceMetric {
  const finishedAt = performanceNow();
  const metric: DivaPerformanceMetric = {
    name: input.name,
    startedAt: input.startedAt,
    durationMs: Math.max(0, finishedAt - input.startedAt),
    segments: input.segments ?? [],
    detail: input.detail,
    recordedAt: new Date().toISOString(),
  };
  metrics.push(metric);
  if (metrics.length > MAX_METRICS) metrics.splice(0, metrics.length - MAX_METRICS);

  if (typeof performance !== 'undefined' && typeof performance.measure === 'function') {
    try {
      performance.measure(`diva:${input.name}`, { start: input.startedAt, end: finishedAt });
    } catch {
      // 古いブラウザではoptions形式のmeasureを利用できないため、記録配列だけを使う。
    }
  }
  if (performanceDebugEnabled()) console.info('[DIVA Performance]', metric);
  return metric;
}

export function getPerformanceMetrics(): readonly DivaPerformanceMetric[] {
  return metrics;
}

export function clearPerformanceMetrics(): void {
  metrics.length = 0;
  if (typeof performance !== 'undefined') {
    performance.clearMeasures?.('diva:search.backend');
    performance.clearMeasures?.('diva:search.vocadb');
    performance.clearMeasures?.('diva:home.load');
  }
}

declare global {
  interface Window {
    __DIVA_PERFORMANCE__?: {
      getMetrics: typeof getPerformanceMetrics;
      clear: typeof clearPerformanceMetrics;
    };
  }
}

if (typeof window !== 'undefined') {
  window.__DIVA_PERFORMANCE__ = {
    getMetrics: getPerformanceMetrics,
    clear: clearPerformanceMetrics,
  };
}
