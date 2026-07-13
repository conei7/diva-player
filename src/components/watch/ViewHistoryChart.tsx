import { useEffect, useMemo, useState } from "react";
import { normalizeViewHistory, type ViewHistoryData } from '../../utils/viewHistory';

interface ChartState {
  songId: number;
  data: ViewHistoryData[];
  loading: boolean;
}

const SERIES = {
  youtube: { label: "YouTube", color: "#ef4444" },
  nico: { label: "ニコニコ動画", color: "#3b82f6" },
} as const;

const Y_TICK_COUNT = 5;
const EMPTY_VIEW_HISTORY: ViewHistoryData[] = [];

const formatJapaneseViews = (views: number): string => {
  const rounded = Math.round(views);

  if (rounded >= 100000000) {
    return (rounded / 100000000).toFixed(1).replace(".0", "") + "億";
  }
  if (rounded >= 10000) {
    return (rounded / 10000).toFixed(1).replace(".0", "") + "万";
  }
  return rounded.toLocaleString();
};


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

const formatDateLabel = (date: string): string => {
  const [, month, day] = date.split("-");
  return `${Number(month)}/${Number(day)}`;
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
    loading: true,
  }));

  const loading = chartState.songId !== songId || chartState.loading;
  const data =
    chartState.songId === songId ? chartState.data : EMPTY_VIEW_HISTORY;

  useEffect(() => {
    let active = true;
    const controller = new AbortController();

    fetch(`/backend-api/api/songs/${songId}/history`, {
      signal: controller.signal,
    })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
        return res.json();
      })
      .then((history: unknown) => {
        if (!active) return;
        setChartState({
          songId,
          data: Array.isArray(history) ? normalizeViewHistory(history) : [],
          loading: false,
        });
      })
      .catch((err) => {
        if (!active || err?.name === "AbortError") return;
        console.error("Failed to fetch view history:", err);
        setChartState({ songId, data: [], loading: false });
      });

    return () => {
      active = false;
      controller.abort();
    };
  }, [songId]);

  const chart = useMemo(() => {
    const hasYoutube = data.some((d) => (d.youtube ?? 0) > 0);
    const hasNico = data.some((d) => (d.nico ?? 0) > 0);
    const maxValue = Math.max(
      ...data.map((d) => Math.max(d.youtube ?? 0, d.nico ?? 0)),
      0,
    );

    if (data.length < 2 || maxValue <= 0) {
      return {
        hasYoutube,
        hasNico,
        pointsYoutube: "",
        pointsNico: "",
        youtubePoints: [],
        nicoPoints: [],
        xLabels: [],
        yTicks: [],
        yMax: 0,
      };
    }

    const yStep = getNiceStep(maxValue / (Y_TICK_COUNT - 1));
    const yMax = yStep * (Y_TICK_COUNT - 1);
    const timestamps = data.map((entry) => Date.parse(`${entry.date}T00:00:00Z`));
    const minTime = Math.min(...timestamps);
    const maxTime = Math.max(...timestamps);
    const timeRange = Math.max(maxTime - minTime, 1);
    const getX = (date: string) => {
      const timestamp = Date.parse(`${date}T00:00:00Z`);
      return ((timestamp - minTime) / timeRange) * 100;
    };
    const getY = (value: number) => 100 - (value / yMax) * 100;

    const youtubePoints = data.filter(d => d.youtube !== null).map((d) => ({
      x: getX(d.date),
      y: getY(d.youtube ?? 0),
      value: d.youtube ?? 0,
      date: d.date,
      corrected: d.correctedYoutube,
    }));
    const nicoPoints = data.filter(d => d.nico !== null).map((d) => ({
      x: getX(d.date),
      y: getY(d.nico ?? 0),
      value: d.nico ?? 0,
      date: d.date,
      corrected: d.correctedNico,
    }));

    const pointsYoutube = youtubePoints.map((p) => `${p.x},${p.y}`).join(" ");
    const pointsNico = nicoPoints.map((p) => `${p.x},${p.y}`).join(" ");

    const labelIndexes = new Set<number>();
    const maxLabels = Math.min(5, data.length);
    for (let i = 0; i < maxLabels; i += 1) {
      labelIndexes.add(
        Math.round(((data.length - 1) * i) / Math.max(maxLabels - 1, 1)),
      );
    }

    const xLabels = [...labelIndexes]
      .sort((a, b) => a - b)
      .map((index) => ({
        x: getX(data[index].date),
        label: formatDateLabel(data[index].date),
      }));

    const yTicks = Array.from({ length: Y_TICK_COUNT }, (_, index) => {
      const value = yStep * index;
      return {
        value,
        y: getY(value),
        label: formatJapaneseViews(value),
      };
    });

    return {
      hasYoutube,
      hasNico,
      pointsYoutube,
      pointsNico,
      youtubePoints,
      nicoPoints,
      xLabels,
      yTicks,
      yMax,
    };
  }, [data]);

  if (loading) {
    return (
      <div
        className="w-full h-[180px] flex items-center justify-center rounded-lg my-4"
        style={{ background: "var(--color-bg-secondary)" }}
      >
        <span className="text-sm" style={{ color: "var(--color-text-muted)" }}>
          Loading history...
        </span>
      </div>
    );
  }

  if (data.length < 2 || chart.yMax <= 0) {
    const historyMessage = data.length === 0
      ? "まだ再生履歴を取得できていません。PVが未登録・非公開、または初回取得待ちの可能性があります。"
      : data.length === 1
        ? "再生履歴は1日分です。次回の取得後に推移グラフを表示します。"
        : "有効な再生数がまだありません。次回の取得結果をお待ちください。";
    return (
      <div
        className="w-full h-[180px] p-4 rounded-lg my-4 shadow-sm flex flex-col items-center justify-center text-center"
        style={{ background: "var(--color-bg-secondary)" }}
      >
        <h3
          className="text-sm font-bold mb-2"
          style={{ color: "var(--color-text-primary)" }}
        >
          再生回数の推移
        </h3>
        <span className="text-xs" style={{ color: "var(--color-text-muted)" }}>
          {historyMessage}
        </span>
      </div>
    );
  }

  return (
    <div
      className="w-full h-[250px] p-4 rounded-lg my-4 shadow-sm flex flex-col"
      style={{ background: "var(--color-bg-secondary)" }}
    >
      <div className="flex justify-between items-center mb-4 gap-4">
        <h3
          className="text-sm font-bold"
          style={{ color: "var(--color-text-primary)" }}
        >
          再生回数の推移
        </h3>
        <div className="flex gap-4 text-xs font-semibold shrink-0">
          {chart.hasYoutube && (
            <span className="flex items-center gap-1">
              <span
                className="w-2 h-2 rounded-full"
                style={{ background: SERIES.youtube.color }}
              ></span>
              {SERIES.youtube.label}
            </span>
          )}
          {chart.hasNico && (
            <span className="flex items-center gap-1">
              <span
                className="w-2 h-2 rounded-full"
                style={{ background: SERIES.nico.color }}
              ></span>
              {SERIES.nico.label}
            </span>
          )}
        </div>
      </div>

      <div className="relative grow ml-16 mb-7">
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
          {chart.hasYoutube && (
            <polyline
              fill="none"
              stroke={SERIES.youtube.color}
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="2"
              points={chart.pointsYoutube}
              vectorEffect="non-scaling-stroke"
            />
          )}
          {chart.hasNico && (
            <polyline
              fill="none"
              stroke={SERIES.nico.color}
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="2"
              points={chart.pointsNico}
              vectorEffect="non-scaling-stroke"
            />
          )}
        </svg>

        {chart.hasYoutube &&
          chart.youtubePoints.map((point) => (
            <div
              key={`youtube-${point.date}`}
              className="absolute w-3 h-3 rounded-full -translate-x-1/2 -translate-y-1/2 border-2 cursor-pointer transition-transform hover:scale-150"
              style={{
                left: `${point.x}%`,
                top: `${point.y}%`,
                background: SERIES.youtube.color,
                borderColor: "var(--color-bg-secondary)",
                zIndex: hoveredPoint?.date === point.date && hoveredPoint?.label === SERIES.youtube.label ? 10 : 1,
              }}
              onMouseEnter={() => setHoveredPoint({ ...point, label: SERIES.youtube.label, color: SERIES.youtube.color })}
              onMouseLeave={() => setHoveredPoint(null)}
            ></div>
          ))}

        {chart.hasNico &&
          chart.nicoPoints.map((point) => (
            <div
              key={`nico-${point.date}`}
              className="absolute w-3 h-3 rounded-full -translate-x-1/2 -translate-y-1/2 border-2 cursor-pointer transition-transform hover:scale-150"
              style={{
                left: `${point.x}%`,
                top: `${point.y}%`,
                background: SERIES.nico.color,
                borderColor: "var(--color-bg-secondary)",
                zIndex: hoveredPoint?.date === point.date && hoveredPoint?.label === SERIES.nico.label ? 10 : 1,
              }}
              onMouseEnter={() => setHoveredPoint({ ...point, label: SERIES.nico.label, color: SERIES.nico.color })}
              onMouseLeave={() => setHoveredPoint(null)}
            ></div>
          ))}

        {hoveredPoint && (
          <div
            className="absolute z-50 pointer-events-none transform -translate-x-1/2 -translate-y-full pb-3"
            style={{ left: `${hoveredPoint.x}%`, top: `${hoveredPoint.y}%` }}
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
                <span className="font-bold text-sm ml-1">{hoveredPoint.value.toLocaleString()}</span>
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
    </div>
  );
}
