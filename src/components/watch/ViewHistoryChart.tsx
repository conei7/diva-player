import { useEffect, useMemo, useRef, useState } from "react";
import {
  aggregateViewHistory,
  bucketForViewHistoryRange,
  formatExactViewCount,
  getViewHistoryYAxisRange,
  getObservedViewHistory,
  normalizeViewHistory,
  toGrowthViewHistory,
  type ViewHistoryData,
  type ViewHistoryMetric,
  type ViewHistoryRange,
} from '../../utils/viewHistory';
import { formatJapaneseViews } from '../../utils/formatViews';
import { useTranslateSourceText } from '../../i18n';
import { useLanguageStore } from '../../stores/languageStore';
import { Chip } from '../ui/Chip';
import Button from '../ui/Button';

interface ChartState {
  songId: number;
  data: ViewHistoryData[];
  status: 'loading' | 'success' | 'error';
}

/** Series colors are data visualization (DESIGN_SPEC §1.2); each series also has a text label. */
const SERIES = {
  youtube: { label: "YouTube", color: "#ef4444" },
  nico: { label: "ニコニコ", color: "#3b82f6" },
} as const;

const Y_TICK_COUNT = 5;
const EMPTY_VIEW_HISTORY: ViewHistoryData[] = [];
type ChartPoint = { x: number; y: number; value: number; date: string; corrected?: boolean };

type ChartSegment = ChartPoint[];


const getNiceStep = (roughStep: number): number => {
  if (!Number.isFinite(roughStep) || roughStep <= 0) return 1;

  const exponent = Math.floor(Math.log10(roughStep));
  const power = 10 ** exponent;
  const fraction = roughStep / power;

  if (fraction <= 1) return power;
  if (fraction <= 2) return 2 * power;
  if (fraction <= 5) return 5 * power;
  return 10 * power;
};

const formatDateLabel = (date: string, includeYear: boolean, language: 'ja' | 'en'): string => {
  return new Intl.DateTimeFormat(language === 'en' ? 'en-US' : 'ja-JP', {
    month: 'numeric',
    day: 'numeric',
    ...(includeYear ? { year: 'numeric' as const } : {}),
    timeZone: 'UTC',
  }).format(new Date(`${date}T00:00:00Z`));
};

const formatChartValue = (value: number, language: 'ja' | 'en'): string => {
  const absolute = Math.abs(value);
  const formatted = language === 'en'
    ? new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(absolute)
    : formatJapaneseViews(absolute, { zeroIsMissing: false, fallback: '0' });
  return value < 0 ? `-${formatted}` : formatted;
};

export default function ViewHistoryChart({ songId }: { songId: number }) {
  const t = useTranslateSourceText();
  const language = useLanguageStore(state => state.language);
  const nicoLabel = t(SERIES.nico.label);
  const [hoveredPoint, setHoveredPoint] = useState<{
    x: number;
    y: number;
    value: number;
    date: string;
    label: string;
    color: string;
    corrected?: boolean;
  } | null>(null);

  const [chartState, setChartState] = useState<ChartState>(() => ({
    songId,
    data: [],
    status: 'loading',
  }));
  const [range, setRange] = useState<ViewHistoryRange>('all');
  const [metric, setMetric] = useState<ViewHistoryMetric>('cumulative');
  const [visibleSeries, setVisibleSeries] = useState({ youtube: true, nico: true });
  const [retryToken, setRetryToken] = useState(0);
  const touchStart = useRef<{ x: number; y: number } | null>(null);

  const loading = chartState.songId !== songId || chartState.status === 'loading';
  const rawData = chartState.songId === songId ? chartState.data : EMPTY_VIEW_HISTORY;
  const bucket = bucketForViewHistoryRange(range);
  const cumulativeData = useMemo(() => aggregateViewHistory(rawData, 'day'), [rawData]);
  const baseline = rawData.find(item => item.baseline) ?? null;
  const data = useMemo(
    () => metric === 'growth'
      ? toGrowthViewHistory(aggregateViewHistory(cumulativeData, bucket), baseline, bucket)
      : cumulativeData,
    [baseline, bucket, cumulativeData, metric],
  );

  const toggleTouchPoint = (point: ChartPoint & { label: string; color: string }) => {
    setHoveredPoint(current => (
      current?.date === point.date && current.label === point.label
        ? null
        : point
    ));
  };

  const showPoint = (point: ChartPoint, label: string, color: string) => {
    setHoveredPoint({ ...point, label, color });
  };

  const handlePointKeyDown = (event: React.KeyboardEvent<HTMLDivElement>, point: ChartPoint, label: string, color: string) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    toggleTouchPoint({ ...point, label, color });
  };

  const handlePointPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'touch') {
      touchStart.current = { x: event.clientX, y: event.clientY };
    }
  };

  const handlePointPointerUp = (event: React.PointerEvent<HTMLDivElement>, point: ChartPoint, label: string, color: string) => {
    if (event.pointerType !== 'touch') return;
    const start = touchStart.current;
    touchStart.current = null;
    if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) <= 8) {
      toggleTouchPoint({ ...point, label, color });
    }
  };

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setChartState({ songId, data: [], status: 'loading' });

    // Fetch daily snapshots once so cumulative mode can show every measurement.
    // Growth mode applies the requested week/month aggregation in the client.
    fetch(`/backend-api/api/songs/${songId}/history?range=${range}&bucket=day`, {
      signal: controller.signal,
    })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
        return res.json();
      })
      .then((history: unknown) => {
        if (!active) return;
        const payload = history && typeof history === 'object' && !Array.isArray(history)
          ? history as { points?: unknown[]; baseline?: unknown }
          : { points: Array.isArray(history) ? history : [], baseline: undefined };
        const rows = payload.baseline && typeof payload.baseline === 'object'
          ? [payload.baseline, ...(payload.points ?? [])]
          : payload.points ?? [];
        setChartState({
          songId,
          data: normalizeViewHistory(rows),
          status: 'success',
        });
      })
      .catch((err) => {
        if (!active || err?.name === "AbortError") return;
        console.error("Failed to fetch view history:", err);
        setChartState({ songId, data: [], status: 'error' });
      });

    return () => {
      active = false;
      controller.abort();
    };
  }, [songId, range, retryToken]);

  useEffect(() => {
    if (!hoveredPoint) return;
    const close = (event: Event) => {
      if (event instanceof KeyboardEvent) {
        if (event.key === 'Escape') setHoveredPoint(null);
        return;
      }
      if (!(event.target as HTMLElement | null)?.closest('.view-history-point')) setHoveredPoint(null);
    };
    document.addEventListener('keydown', close);
    document.addEventListener('pointerdown', close);
    return () => {
      document.removeEventListener('keydown', close);
      document.removeEventListener('pointerdown', close);
    };
  }, [hoveredPoint]);

  const chart = useMemo(() => {
    const hasYoutube = data.some((d) => d.youtube !== null);
    const hasNico = data.some((d) => d.nico !== null);
    const valueRange = getViewHistoryYAxisRange(data, metric, visibleSeries);

    if (data.length < 2 || valueRange.yMax <= 0) {
      return {
        hasYoutube,
        hasNico,
        youtubeSegments: [] as ChartSegment[],
        nicoSegments: [] as ChartSegment[],
        youtubePoints: [],
        nicoPoints: [],
        xLabels: [],
        yTicks: [],
        yMin: 0,
        yMax: 0,
        ready: false,
      };
    }

    const yStep = getNiceStep(valueRange.yMax / (Y_TICK_COUNT - 1));
    const yMax = yStep * (Y_TICK_COUNT - 1);
    const yMin = valueRange.yMin < 0 ? -yMax : 0;
    const timestamps = data.map((entry) => Date.parse(`${entry.date}T00:00:00Z`));
    const minTime = Math.min(...timestamps);
    const maxTime = Math.max(...timestamps);
    const timeRange = Math.max(maxTime - minTime, 1);
    const getX = (date: string) => {
      const timestamp = Date.parse(`${date}T00:00:00Z`);
      return ((timestamp - minTime) / timeRange) * 100;
    };
    const getY = (value: number) => 100 - ((value - yMin) / Math.max(yMax - yMin, 1)) * 100;

    const buildSeries = (service: 'youtube' | 'nico') => {
      const points: ChartPoint[] = getObservedViewHistory(data, service).map(item => {
        const value = item[service] as number;
        return {
          x: getX(item.date),
          y: getY(value),
          value,
          date: item.date,
          corrected: service === 'youtube' ? item.correctedYoutube : item.correctedNico,
        };
      });
      return { points, segments: points.length > 0 ? [points] : [] };
    };

    const youtube = buildSeries('youtube');
    const nico = buildSeries('nico');

    const labelIndexes = new Set<number>();
    const maxLabels = Math.min(5, data.length);
    for (let i = 0; i < maxLabels; i += 1) {
      labelIndexes.add(
        Math.round(((data.length - 1) * i) / Math.max(maxLabels - 1, 1)),
      );
    }

    const includeYear = new Set(data.map(item => item.date.slice(0, 4))).size > 1;
    const xLabels = [...labelIndexes]
      .sort((a, b) => a - b)
      .map((index) => ({
        x: getX(data[index].date),
        label: formatDateLabel(data[index].date, includeYear, language),
      }));

    const yTicks = Array.from({ length: Y_TICK_COUNT }, (_, index) => {
      const value = yMin + yStep * index;
      return {
        value,
        y: getY(value),
        label: formatChartValue(value, language),
      };
    });

    return {
      hasYoutube,
      hasNico,
      youtubeSegments: youtube.segments,
      nicoSegments: nico.segments,
      youtubePoints: youtube.points,
      nicoPoints: nico.points,
      xLabels,
      yTicks,
      yMin,
      yMax,
      ready: true,
    };
  }, [data, language, metric, visibleSeries]);

  const legend = (chart.hasYoutube || chart.hasNico) && (
    <div className="flex flex-wrap gap-2" role="group" aria-label={t('表示する系列')}>
      {chart.hasYoutube && (
        <Chip
          selected={visibleSeries.youtube}
          icon={<span className="block size-2.5 rounded-full" style={{ background: SERIES.youtube.color }} />}
          onClick={() => setVisibleSeries(value => ({ ...value, youtube: !value.youtube }))}
        >
          {SERIES.youtube.label}
        </Chip>
      )}
      {chart.hasNico && (
        <Chip
          selected={visibleSeries.nico}
          icon={<span className="block size-2.5 rounded-full" style={{ background: SERIES.nico.color }} />}
          onClick={() => setVisibleSeries(value => ({ ...value, nico: !value.nico }))}
        >
          {nicoLabel}
        </Chip>
      )}
    </div>
  );

  return (
    <section className="flex min-w-0 flex-col" aria-label={t('再生数の推移')}>
      <h3 className="text-base font-bold leading-[22px] text-yt-text">{t('再生数の推移')}</h3>
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex flex-wrap gap-2" role="group" aria-label={t('表示指標')}>
          {(['growth', 'cumulative'] as const).map(option => (
            <Chip key={option} selected={metric === option} onClick={() => setMetric(option)}>
              {t(option === 'growth' ? '増加数' : '累計')}
            </Chip>
          ))}
        </div>
        <div className="flex flex-wrap gap-2" role="group" aria-label={t('期間')}>
          {(['7d', '30d', '90d', 'all'] as const).map(option => (
            <Chip key={option} selected={range === option} onClick={() => setRange(option)}>
              {option === 'all' ? t('全期間') : t('{count}日', { count: Number.parseInt(option, 10) })}
            </Chip>
          ))}
        </div>
        {legend}
      </div>

      {loading ? (
        <div className="mt-4 flex h-[200px] items-center justify-center text-sm text-yt-text-secondary">
          {t('読み込み中…')}
        </div>
      ) : chartState.status === 'error' ? (
        <div className="mt-4 flex h-[200px] flex-col items-center justify-center gap-2 text-center" role="alert">
          <span className="text-sm text-yt-text-secondary">{t('再生数の推移を読み込めませんでした')}</span>
          <Button variant="text" size="sm" onClick={() => setRetryToken(value => value + 1)}>
            {t('再試行')}
          </Button>
        </div>
      ) : !chart.ready ? (
        <div className="mt-4 flex h-[200px] items-center justify-center text-center text-sm text-yt-text-secondary">
          {data.length === 0
            ? t('この期間のデータはありません')
            : data.length === 1
              ? t('データが足りません')
              : t('まだ変化はありません')}
        </div>
      ) : (
      <div className="relative mb-7 ml-16 mt-4 h-[200px]">
        {chart.yTicks.map((tick) => (
          <div
            key={tick.value}
            className="absolute inset-x-0"
            style={{ top: `${tick.y}%` }}
          >
            <div className="absolute -left-16 w-14 -translate-y-1/2 text-right text-xs tabular-nums text-yt-text-secondary">
              {tick.label}
            </div>
            <div
              className="border-t border-dashed"
              style={{ borderColor: "rgba(255,255,255,0.08)" }}
            ></div>
          </div>
        ))}

        <div className="absolute inset-0 border-b border-l border-[rgba(255,255,255,0.16)]"></div>

        <svg
          className="absolute inset-0 w-full h-full pointer-events-none"
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          overflow="visible"
        >
          {chart.hasYoutube && visibleSeries.youtube && chart.youtubeSegments.map((segment, index) => (
            <polyline
              key={`youtube-segment-${index}`}
              fill="none"
              stroke={SERIES.youtube.color}
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="2"
              points={segment.map(point => `${point.x},${point.y}`).join(' ')}
              vectorEffect="non-scaling-stroke"
            />
          ))}
          {chart.hasNico && visibleSeries.nico && chart.nicoSegments.map((segment, index) => (
            <polyline
              key={`nico-segment-${index}`}
              fill="none"
              stroke={SERIES.nico.color}
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="2"
              points={segment.map(point => `${point.x},${point.y}`).join(' ')}
              vectorEffect="non-scaling-stroke"
            />
          ))}
        </svg>

        {chart.hasYoutube && visibleSeries.youtube &&
          chart.youtubePoints.map((point) => (
            <div
              key={`youtube-${point.date}`}
              className="view-history-point absolute w-6 h-6 p-1 rounded-full -translate-x-1/2 -translate-y-1/2 border-2 cursor-pointer transition-transform hover:scale-125"
              role="button"
              tabIndex={0}
              aria-label={`${SERIES.youtube.label} ${point.date} ${formatExactViewCount(point.value, language === 'en' ? 'en-US' : 'ja-JP')}`}
              style={{
                left: `${point.x}%`,
                top: `${point.y}%`,
                background: SERIES.youtube.color,
                borderColor: "var(--color-yt-tonal-solid)",
                zIndex: hoveredPoint?.date === point.date && hoveredPoint?.label === SERIES.youtube.label ? 10 : 1,
              }}
              onMouseEnter={() => showPoint(point, SERIES.youtube.label, SERIES.youtube.color)}
              onMouseLeave={() => setHoveredPoint(null)}
              onFocus={() => showPoint(point, SERIES.youtube.label, SERIES.youtube.color)}
              onBlur={() => setHoveredPoint(null)}
              onKeyDown={(event) => handlePointKeyDown(event, point, SERIES.youtube.label, SERIES.youtube.color)}
              onPointerDown={handlePointPointerDown}
              onPointerUp={(event) => handlePointPointerUp(event, point, SERIES.youtube.label, SERIES.youtube.color)}
              onPointerCancel={() => { touchStart.current = null; }}
            ></div>
          ))}

        {chart.hasNico && visibleSeries.nico &&
          chart.nicoPoints.map((point) => (
            <div
              key={`nico-${point.date}`}
              className="view-history-point absolute w-6 h-6 p-1 rounded-full -translate-x-1/2 -translate-y-1/2 border-2 cursor-pointer transition-transform hover:scale-125"
              role="button"
              tabIndex={0}
              aria-label={`${nicoLabel} ${point.date} ${formatExactViewCount(point.value, language === 'en' ? 'en-US' : 'ja-JP')}`}
              style={{
                left: `${point.x}%`,
                top: `${point.y}%`,
                background: SERIES.nico.color,
                borderColor: "var(--color-yt-tonal-solid)",
                zIndex: hoveredPoint?.date === point.date && hoveredPoint?.label === nicoLabel ? 10 : 1,
              }}
              onMouseEnter={() => showPoint(point, nicoLabel, SERIES.nico.color)}
              onMouseLeave={() => setHoveredPoint(null)}
              onFocus={() => showPoint(point, nicoLabel, SERIES.nico.color)}
              onBlur={() => setHoveredPoint(null)}
              onKeyDown={(event) => handlePointKeyDown(event, point, nicoLabel, SERIES.nico.color)}
              onPointerDown={handlePointPointerDown}
              onPointerUp={(event) => handlePointPointerUp(event, point, nicoLabel, SERIES.nico.color)}
              onPointerCancel={() => { touchStart.current = null; }}
            ></div>
          ))}

        {hoveredPoint && (
          <div
            className="absolute z-50 pointer-events-none transform -translate-x-1/2 -translate-y-full pb-3"
            style={{ left: `${Math.min(96, Math.max(4, hoveredPoint.x))}%`, top: `${Math.max(16, hoveredPoint.y)}%` }}
          >
            <div className="flex flex-col gap-1 whitespace-nowrap rounded-chip bg-yt-menu px-3 py-2 text-xs font-medium text-yt-text shadow-[0_4px_32px_rgba(0,0,0,0.5)]">
              <div className="text-yt-text-secondary">{hoveredPoint.date}</div>
              <div className="flex items-center gap-1.5 mt-0.5">
                <span className="w-2 h-2 rounded-full" style={{ background: hoveredPoint.color }}></span>
                <span>{hoveredPoint.label}:</span>
                <span className="font-bold text-sm ml-1 tabular-nums">{formatExactViewCount(hoveredPoint.value)}</span>
              </div>
              {hoveredPoint.corrected && <div className="text-yt-text-secondary">{t('異常値を補正')}</div>}
            </div>
          </div>
        )}

        {chart.xLabels.map((label) => (
          <div
            key={label.label}
            className="absolute -bottom-6 -translate-x-1/2 text-xs tabular-nums text-yt-text-secondary"
            style={{ left: `${label.x}%` }}
          >
            {label.label}
          </div>
        ))}
      </div>
      )}
    </section>
  );
}
