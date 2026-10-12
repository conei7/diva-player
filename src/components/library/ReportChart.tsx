import { cx } from '../ui/overlay';

export interface ReportChartBar {
  key: string;
  value: number;
  /** The value split into the stacked series (same order as `series`, bottom first). */
  parts?: readonly number[];
  /** Full label for screen readers and the hover label (10月3日 / Oct 3). */
  label: string;
  /** Short tick text, or undefined for no tick. */
  axisLabel?: string;
  /** Formatted value (12回 / 1時間5分). */
  valueText: string;
  /** Formatted split, the hover label's second line and the end of the aria-label (手動 3 · 自動 2). */
  partsText?: string;
}

export interface ReportChartSeries {
  key: string;
  /** Legend text with the period's total, already formatted (手動 7). */
  legend: string;
}

export interface ReportChartProps {
  bars: ReportChartBar[];
  /** 'duration' values are seconds. */
  scale: 'count' | 'duration';
  formatValue: (value: number) => string;
  /** Caption above the chart and the name of the bar group. */
  title: string;
  /** Stacked series (at most two: brand, then neutral gray). With two, the bars stack their `parts` and a legend is shown. */
  series?: readonly ReportChartSeries[];
  /** Wraps the chart in a tabpanel labelled by the selected metric tab. */
  panelId?: string;
  labelledBy?: string;
}

const COUNT_STEPS = [2, 4, 10];
const DURATION_MINUTES = [2, 10, 20, 30, 60, 120, 240, 360, 600, 1200, 2400, 6000, 12000, 24000, 60000];

/**
 * Series colors, bottom first: the brand color, then a neutral gray (the design keeps colors to the brand
 * and grays). Both clear 3:1 on the page and stay apart under color-blind simulation; the hover step is lighter.
 */
const SERIES_STYLES = [
  { segment: 'bg-brand/75 group-hover/bar:bg-brand', swatch: 'bg-brand/75' },
  { segment: 'bg-[#606060] group-hover/bar:bg-[#717171]', swatch: 'bg-[#606060]' },
] as const;

/** Keeps the hover label inside the chart: anchored left on the first third, right on the last third. */
const HOVER_ALIGN = {
  start: 'left-0',
  center: 'left-1/2 -translate-x-1/2',
  end: 'right-0',
} as const;

/** A round maximum whose half is also a round value (so both gridline labels read cleanly). */
function niceMaximum(max: number, scale: 'count' | 'duration'): number {
  if (scale === 'duration') {
    const minutes = max / 60;
    const step = DURATION_MINUTES.find(value => value >= minutes);
    return (step ?? Math.ceil(minutes / 60000) * 60000) * 60;
  }
  for (let magnitude = 1; magnitude < 1e12; magnitude *= 10) {
    for (const step of COUNT_STEPS) {
      if (step * magnitude >= max) return step * magnitude;
    }
  }
  return max;
}

/** 220px bar chart with two labelled gridlines on the right and sparse ticks below. */
export default function ReportChart({ bars, scale, formatValue, title, series, panelId, labelledBy }: ReportChartProps) {
  const top = niceMaximum(Math.max(1, ...bars.map(bar => bar.value)), scale);
  const stacked = (series?.length ?? 0) > 1;

  return (
    <div id={panelId} role={panelId ? 'tabpanel' : undefined} aria-labelledby={labelledBy} className="pt-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        {/* A caption under the tabs (the selected tab names the metric), not another heading. */}
        <p className="m-0 text-sm leading-5 font-medium text-yt-text">{title}</p>
        {stacked && series && (
          <ul className="m-0 flex list-none flex-wrap items-center gap-x-4 gap-y-1 p-0 text-xs leading-4 text-yt-text-secondary tabular-nums">
            {series.map((item, index) => (
              <li key={item.key} className="flex items-center gap-1.5">
                <span aria-hidden="true" className={cx('size-2.5 shrink-0 rounded-[2px]', SERIES_STYLES[index]?.swatch)} />
                {item.legend}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="relative h-[220px] pr-14">
        {[1, 0.5, 0].map(position => (
          <div
            key={position}
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 border-t border-yt-divider"
            style={{ bottom: `${position * 100}%` }}
          >
            {position > 0 && (
              <span className="absolute right-0 -translate-y-1/2 text-xs leading-4 text-yt-text-secondary tabular-nums">
                {formatValue(top * position)}
              </span>
            )}
          </div>
        ))}
        <div role="group" aria-label={title} className="relative flex h-full items-end gap-0.5 sm:gap-1">
          {bars.map((bar, index) => {
            const percent = bar.value > 0 ? Math.max(1, Math.min(100, (bar.value / top) * 100)) : 0;
            const parts = stacked && bar.parts ? bar.parts : [bar.value];
            const topPart = parts.reduce((last, part, partIndex) => (part > 0 ? partIndex : last), -1);
            const align = index < bars.length / 3 ? 'start' : index >= bars.length - bars.length / 3 ? 'end' : 'center';
            return (
              <div
                key={bar.key}
                role="img"
                aria-label={[`${bar.label}: ${bar.valueText}`, bar.partsText].filter(Boolean).join(' · ')}
                className="group/bar relative flex h-full min-w-0 flex-1 items-end justify-center"
              >
                {percent > 0 && (
                  // Thin bars (24px at most) grow from the baseline; stacked parts are 2px apart, only the top one is rounded.
                  <div className="flex w-full max-w-6 flex-col-reverse gap-0.5" style={{ height: `${percent}%`, minHeight: 2 }}>
                    {parts.map((part, partIndex) => part > 0 && (
                      <div
                        key={partIndex}
                        className={cx(
                          'min-h-0.5 transition-colors duration-150',
                          (SERIES_STYLES[partIndex] ?? SERIES_STYLES[0]).segment,
                          partIndex === topPart && 'rounded-t-[4px]',
                        )}
                        style={{ flex: `${part} 1 0` }}
                      />
                    ))}
                  </div>
                )}
                <span
                  aria-hidden="true"
                  className={cx(
                    'pointer-events-none absolute z-[1] mb-1 hidden whitespace-nowrap rounded-badge bg-[rgba(97,97,97,0.92)] px-2 py-1 text-xs leading-4 text-white group-hover/bar:block',
                    HOVER_ALIGN[align],
                  )}
                  style={{ bottom: `${percent}%` }}
                >
                  <span className="block">{bar.label}: {bar.valueText}</span>
                  {bar.partsText && <span className="block">{bar.partsText}</span>}
                </span>
              </div>
            );
          })}
        </div>
      </div>
      <div aria-hidden="true" className="mt-2 flex gap-0.5 pr-14 sm:gap-1">
        {bars.map(bar => (
          <div key={bar.key} className="relative h-4 min-w-0 flex-1">
            {bar.axisLabel && (
              <span className="absolute left-1/2 -translate-x-1/2 whitespace-nowrap text-xs leading-4 text-yt-text-secondary tabular-nums">
                {bar.axisLabel}
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
