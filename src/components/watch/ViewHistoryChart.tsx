import { useEffect, useMemo, useRef, useState } from "react";
import {
  aggregateViewHistory,
  bucketForViewHistoryRange,
  normalizeViewHistory,
  toGrowthViewHistory,
  type ViewHistoryData,
  type ViewHistoryMetric,
  type ViewHistoryRange,
} from '../../utils/viewHistory';
import { formatJapaneseViews } from '../../utils/formatViews';

interface ChartState {
  songId: number;
  data: ViewHistoryData[];
  status: 'loading' | 'success' | 'error';
  errorMessage?: string;
}

const SERIES = {
  youtube: { label: "YouTube", color: "#ef4444" },
  nico: { label: "ニコニコ動画", color: "#3b82f6" },
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

const formatDateLabel = (date: string, includeYear = false): string => {
  const [year, month, day] = date.split("-");
  if (includeYear) return `${Number(year)}/${Number(month)}/${Number(day)}`;
  return `${Number(month)}/${Number(day)}`;
};

const formatChartValue = (value: number): string => {
  if (value < 0) return `-${formatJapaneseViews(Math.abs(value), { zeroIsMissing: false, fallback: '0' })}`;
  return formatJapaneseViews(value, { zeroIsMissing: false, fallback: '0' });
};

export default function ViewHistoryChart({ songId }: { songId: number }) {
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
  const [range, setRange] = useState<ViewHistoryRange>('30d');
  const [metric, setMetric] = useState<ViewHistoryMetric>('growth');
  const [visibleSeries, setVisibleSeries] = useState({ youtube: true, nico: true });
  const [retryToken, setRetryToken] = useState(0);
  const touchStart = useRef<{ x: number; y: number } | null>(null);

  const loading = chartState.songId !== songId || chartState.status === 'loading';
  const rawData = chartState.songId === songId ? chartState.data : EMPTY_VIEW_HISTORY;
  const bucket = bucketForViewHistoryRange(range);
  const cumulativeData = useMemo(() => aggregateViewHistory(rawData, bucket), [rawData, bucket]);
  const baseline = rawData.find(item => item.baseline) ?? null;
  const data = useMemo(
    () => metric === 'growth' ? toGrowthViewHistory(cumulativeData, baseline) : cumulativeData,
    [baseline, cumulativeData, metric],
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

    const bucket = bucketForViewHistoryRange(range);
    fetch(`/backend-api/api/songs/${songId}/history?range=${range}&bucket=${bucket}`, {
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
        setChartState({ songId, data: [], status: 'error', errorMessage: '閲覧履歴を取得できませんでした。' });
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
    const maxAbsValue = Math.max(
      ...data.flatMap((d) => [d.youtube, d.nico].filter((value): value is number => value !== null).map(Math.abs)),
      0,
    );

    if (data.length < 2 || maxAbsValue <= 0) {
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

    const yStep = getNiceStep(maxAbsValue / (Y_TICK_COUNT - 1));
    const yMax = yStep * (Y_TICK_COUNT - 1);
    const yMin = metric === 'growth' ? -yMax : 0;
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
      const points: ChartPoint[] = [];
      const segments: ChartSegment[] = [];
      let segment: ChartSegment = [];
      data.forEach((item, index) => {
        const value = item[service];
        if (value === null) {
          if (segment.length > 0) segments.push(segment);
          segment = [];
          return;
        }
        const point = {
          x: getX(item.date),
          y: getY(value),
          value,
          date: item.date,
          corrected: service === 'youtube' ? item.correctedYoutube : item.correctedNico,
        };
        if (index > 0 && data[index - 1][service] === null && segment.length > 0) {
          segments.push(segment);
          segment = [];
        }
        segment.push(point);
        points.push(point);
      });
      if (segment.length > 0) segments.push(segment);
      return { points, segments };
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
        label: formatDateLabel(data[index].date, includeYear),
      }));

    const yTicks = Array.from({ length: Y_TICK_COUNT }, (_, index) => {
      const value = metric === 'growth' ? yMin + yStep * index : yStep * index;
      return {
        value,
        y: getY(value),
        label: formatChartValue(value),
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
  }, [data, metric]);

  return (
    <div
      className="w-full min-h-[250px] p-4 rounded-lg my-4 shadow-sm flex flex-col"
      style={{ background: "var(--color-bg-secondary)" }}
    >
      <div className="flex justify-between items-center mb-4 gap-4 flex-wrap">
        <h3
          className="text-sm font-bold"
          style={{ color: "var(--color-text-primary)" }}
        >
          再生回数の推移
        </h3>
        <div className="flex gap-1 shrink-0 max-w-full overflow-x-auto" role="group" aria-label="表示指標">
          {(['growth', 'cumulative'] as const).map(option => (
            <button
              key={option}
              type="button"
              aria-pressed={metric === option}
              className="px-2 py-1 rounded text-[10px] border"
              style={{
                color: metric === option ? 'var(--color-text-primary)' : 'var(--color-text-muted)',
                borderColor: metric === option ? 'var(--color-accent-cyan)' : 'var(--color-border)',
              }}
              onClick={() => setMetric(option)}
            >
              {option === 'growth' ? '増加数' : '累計'}
            </button>
          ))}
        </div>
        <div className="flex gap-1 shrink-0 max-w-full overflow-x-auto" role="group" aria-label="期間">
          {(['7d', '30d', '90d', 'all'] as const).map(option => (
            <button
              key={option}
              type="button"
              aria-pressed={range === option}
              className="px-2 py-1 rounded text-[10px] border"
              style={{
                color: range === option ? 'var(--color-text-primary)' : 'var(--color-text-muted)',
                borderColor: range === option ? 'var(--color-accent-cyan)' : 'var(--color-border)',
              }}
              onClick={() => setRange(option)}
            >
              {option === 'all' ? '全期間' : option.replace('d', '日')}
            </button>
          ))}
        </div>
        <div className="flex gap-2 text-xs font-semibold shrink-0">
          {chart.hasYoutube && (
            <button
              type="button"
              aria-pressed={visibleSeries.youtube}
              className="flex items-center gap-1 opacity-100 aria-[pressed=false]:opacity-40"
              onClick={() => setVisibleSeries(value => ({ ...value, youtube: !value.youtube }))}
            >
              <span
                className="w-2 h-2 rounded-full"
                style={{ background: SERIES.youtube.color }}
              ></span>
              {SERIES.youtube.label}
            </button>
          )}
          {chart.hasNico && (
            <button
              type="button"
              aria-pressed={visibleSeries.nico}
              className="flex items-center gap-1 opacity-100 aria-[pressed=false]:opacity-40"
              onClick={() => setVisibleSeries(value => ({ ...value, nico: !value.nico }))}
            >
              <span
                className="w-2 h-2 rounded-full"
                style={{ background: SERIES.nico.color }}
              ></span>
              {SERIES.nico.label}
            </button>
          )}
        </div>
      </div>

      {loading ? (
        <div className="grow min-h-[170px] flex items-center justify-center text-sm" style={{ color: "var(--color-text-muted)" }}>
          履歴を読み込んでいます…
        </div>
      ) : chartState.status === 'error' ? (
        <div className="grow min-h-[170px] flex flex-col items-center justify-center gap-3 text-center" role="alert">
          <span className="text-sm" style={{ color: "var(--color-text-muted)" }}>{chartState.errorMessage}</span>
          <button
            type="button"
            className="px-3 py-1.5 rounded-md text-xs font-semibold border"
            style={{ color: "var(--color-text-primary)", borderColor: "var(--color-border)" }}
            onClick={() => setRetryToken(value => value + 1)}
          >
            再試行
          </button>
        </div>
      ) : !chart.ready ? (
        <div className="grow min-h-[170px] p-4 flex flex-col items-center justify-center text-center">
          <span className="text-xs" style={{ color: "var(--color-text-muted)" }}>
            {data.length === 0
              ? "この期間の再生履歴はありません。別の期間を選択できます。"
              : data.length === 1
                ? "比較できる再生履歴が1点しかありません。別の期間を選択できます。"
                : "有効な再生数の変化がまだありません。"}
          </span>
        </div>
      ) : (
      <div className="relative grow min-h-[170px] ml-16 mb-7">
        {chart.yTicks.map((tick) => (
          <div
            key={tick.value}
            className="absolute inset-x-0"
            style={{ top: `${tick.y}%` }}
          >
            <div
              className="absolute -left-16 w-14 -translate-y-1/2 text-right text-[10px] tabular-nums"
              style={{ color: "var(--color-text-muted)" }}
            >
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
              aria-label={`${SERIES.youtube.label} ${point.date} ${formatChartValue(point.value)}`}
              style={{
                left: `${point.x}%`,
                top: `${point.y}%`,
                background: SERIES.youtube.color,
                borderColor: "var(--color-bg-secondary)",
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
              aria-label={`${SERIES.nico.label} ${point.date} ${formatChartValue(point.value)}`}
              style={{
                left: `${point.x}%`,
                top: `${point.y}%`,
                background: SERIES.nico.color,
                borderColor: "var(--color-bg-secondary)",
                zIndex: hoveredPoint?.date === point.date && hoveredPoint?.label === SERIES.nico.label ? 10 : 1,
              }}
              onMouseEnter={() => showPoint(point, SERIES.nico.label, SERIES.nico.color)}
              onMouseLeave={() => setHoveredPoint(null)}
              onFocus={() => showPoint(point, SERIES.nico.label, SERIES.nico.color)}
              onBlur={() => setHoveredPoint(null)}
              onKeyDown={(event) => handlePointKeyDown(event, point, SERIES.nico.label, SERIES.nico.color)}
              onPointerDown={handlePointPointerDown}
              onPointerUp={(event) => handlePointPointerUp(event, point, SERIES.nico.label, SERIES.nico.color)}
              onPointerCancel={() => { touchStart.current = null; }}
            ></div>
          ))}

        {hoveredPoint && (
          <div
            className="absolute z-50 pointer-events-none transform -translate-x-1/2 -translate-y-full pb-3"
            style={{ left: `${Math.min(96, Math.max(4, hoveredPoint.x))}%`, top: `${Math.max(16, hoveredPoint.y)}%` }}
          >
            <div
              className="px-3 py-2 rounded-lg shadow-xl text-xs font-medium flex flex-col gap-1 whitespace-nowrap border"
              style={{ 
                background: "var(--color-bg-card)", 
                borderColor: "var(--color-border)",
                color: "var(--color-text-primary)" 
              }}
            >
              <div style={{ color: "var(--color-text-muted)" }}>{hoveredPoint.date}</div>
              <div className="flex items-center gap-1.5 mt-0.5">
                <span className="w-2 h-2 rounded-full" style={{ background: hoveredPoint.color }}></span>
                <span>{hoveredPoint.label}:</span>
                <span className="font-bold text-sm ml-1">{formatChartValue(hoveredPoint.value)}</span>
              </div>
              {hoveredPoint.corrected && <div className="text-amber-300">異常値を補正</div>}
            </div>
          </div>
        )}

        {chart.xLabels.map((label) => (
          <div
            key={label.label}
            className="absolute -bottom-6 text-[10px] transform -translate-x-1/2 tabular-nums"
            style={{ left: `${label.x}%`, color: "var(--color-text-muted)" }}
          >
            {label.label}
          </div>
        ))}
      </div>
      )}
    </div>
  );
}
