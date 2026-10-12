import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import {
  buildHistoryReportCsv,
  DEFAULT_TIME_ZONE,
  getHistoryReport,
  type HistoryReport,
  type ReportBucket,
} from '../services/historyStats';
import { useAutoPlaySessionStore } from '../stores/autoPlaySessionStore';
import { useAutoQueueDecisionStore } from '../stores/autoQueueDecisionStore';
import { useLanguageStore } from '../stores/languageStore';
import { showToast } from '../stores/toastStore';
import { useTranslateSourceText } from '../i18n';
import { MOBILE_MEDIA_QUERY, useMediaQuery } from '../hooks/useMediaQuery';
import { downloadCsv } from '../utils/csv';
import { toSafeFileName } from '../utils/playlistBackup';
import { watchPath } from '../utils/routes';
import { formatCount, formatTotalDuration } from '../utils/songMeta';
import Button from '../components/ui/Button';
import EmptyState from '../components/ui/EmptyState';
import IconButton from '../components/ui/IconButton';
import Menu, { MenuItem } from '../components/ui/Menu';
import { PageHeader, PageShell } from '../components/ui/PageHeader';
import { SkeletonBlock } from '../components/ui/Skeleton';
import SongListRow from '../components/ui/SongListRow';
import { BarChartIcon, ChevronDownIcon, DownloadIcon, ErrorIcon, MoreVertIcon } from '../components/ui/icons';
import MetricTabs from '../components/library/MetricTabs';
import PeriodMenu from '../components/library/PeriodMenu';
import ReportChart from '../components/library/ReportChart';
import {
  fillReportBuckets,
  formatBucketLabel,
  formatPlays,
  presetRange,
  shiftReportRange,
  showsAxisLabel,
  type ReportRange,
} from '../components/library/reportPeriod';

type Metric = 'plays' | 'time' | 'songs' | 'finished';

const TOP_SONGS_COLLAPSED = 10;
const TOP_SONGS_EXPANDED = 20;

function bucketValue(bucket: ReportBucket, metric: Metric): number {
  switch (metric) {
    case 'time': return bucket.listenedSeconds;
    case 'songs': return bucket.uniqueSongs;
    case 'finished': return bucket.completes;
    default: return bucket.qualifiedPlays;
  }
}

/**
 * The bucket's value split into [played by hand, autoplay] for the stacked bars.
 * Songs are not split: one song can be played both ways in a day, so the parts would not add up.
 */
function bucketParts(bucket: ReportBucket, metric: Metric): [number, number] | null {
  switch (metric) {
    case 'time': return [bucket.listenedSeconds - bucket.autoListenedSeconds, bucket.autoListenedSeconds];
    case 'songs': return null;
    case 'finished': return [bucket.completes - bucket.autoCompletes, bucket.autoCompletes];
    default: return [bucket.qualifiedPlays - bucket.autoQualifiedPlays, bucket.autoQualifiedPlays];
  }
}

/**
 * ReportsPage - レポート（YouTube Studio のアナリティクスの型: 期間・指標タブ・棒グラフ・よく聴いた曲）
 */
export default function ReportsPage() {
  const t = useTranslateSourceText();
  const language = useLanguageStore(state => state.language);
  const navigate = useNavigate();
  const isMobile = useMediaQuery(MOBILE_MEDIA_QUERY);
  const [now] = useState(() => Date.now());
  const [range, setRange] = useState<ReportRange>(() => presetRange('thisMonth', now, DEFAULT_TIME_ZONE));
  const [metric, setMetric] = useState<Metric>('plays');
  const [report, setReport] = useState<HistoryReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const [showAllTopSongs, setShowAllTopSongs] = useState(false);
  const autoPlaySession = useAutoPlaySessionStore(state => state.session);
  const autoQueueDecisionCount = useAutoQueueDecisionStore(state => state.decisions.length);

  useEffect(() => {
    let current = true;
    setLoading(true);
    setFailed(false);
    getHistoryReport(range.period, range.key, DEFAULT_TIME_ZONE, language)
      .then(next => { if (current) setReport(next); })
      .catch(error => {
        console.error('[Reports] Failed to load the report', error);
        if (current) setFailed(true);
      })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [range, reloadToken, language]);

  useEffect(() => {
    setShowAllTopSongs(false);
  }, [range]);

  // A report of another period stays on screen only while the same period reloads.
  const currentReport = report && report.period === range.period && report.key === range.key ? report : null;
  const buckets = useMemo(
    () => (currentReport ? fillReportBuckets(currentReport.buckets, range) : []),
    [currentReport, range],
  );

  const metricLabels: Record<Metric, string> = {
    plays: t('再生回数'),
    time: t('再生時間'),
    songs: t('聴いた曲'),
    finished: t('最後まで聴いた'),
  };

  const formatMetric = (value: number, which: Metric): string => {
    if (which === 'time') return formatTotalDuration(value, language);
    if (which === 'songs') return formatCount(value, 'song', language);
    return formatPlays(value, language);
  };

  const handleCsvExport = () => {
    if (!currentReport) return;
    const name = range.period === 'all'
      ? 'diva-listening-report-all.csv'
      : `diva-listening-report-${toSafeFileName(range.period)}-${toSafeFileName(range.key)}.csv`;
    try {
      downloadCsv(name, buildHistoryReportCsv(currentReport, language));
      showToast(t('CSVをエクスポートしました'));
    } catch (error) {
      console.error('[Reports] Failed to export CSV', error);
      showToast(t('CSVをエクスポートできませんでした'));
    }
  };

  const previousRange = shiftReportRange(range, -1);
  const periodControl = (
    <PeriodMenu range={range} onChange={setRange} now={now} timeZone={DEFAULT_TIME_ZONE} fullWidth={isMobile} />
  );
  const moreMenu = (
    <Menu trigger={<IconButton label={t('その他の操作')} icon={<MoreVertIcon />} />} align="end">
      <MenuItem icon={<DownloadIcon />} disabled={loading || !currentReport} onSelect={handleCsvExport}>
        {t('CSVでエクスポート')}
      </MenuItem>
    </Menu>
  );

  let body: ReactNode;
  if (failed) {
    body = (
      <EmptyState
        icon={<ErrorIcon />}
        title={t('読み込めませんでした')}
        action={{ label: t('再試行'), onClick: () => setReloadToken(token => token + 1) }}
      />
    );
  } else if (!currentReport) {
    body = (
      <div aria-busy="true">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          {Array.from({ length: 4 }, (_, index) => <SkeletonBlock key={index} className="h-[72px] rounded-card" />)}
        </div>
        <SkeletonBlock className="mt-6 h-[220px] rounded-card" />
      </div>
    );
  } else if (currentReport.totalStarts === 0) {
    body = (
      <EmptyState
        icon={<BarChartIcon />}
        title={t('この期間の再生はありません')}
        action={previousRange ? { label: t('前の期間'), onClick: () => setRange(previousRange) } : undefined}
      />
    );
  } else {
    const topSongs = currentReport.topSongsWithMeta.slice(0, showAllTopSongs ? TOP_SONGS_EXPANDED : TOP_SONGS_COLLAPSED);
    const chartTitle = range.period === 'month'
      ? t('日別の{metric}', { metric: metricLabels[metric] })
      : range.period === 'year'
        ? t('月別の{metric}', { metric: metricLabels[metric] })
        : t('年別の{metric}', { metric: metricLabels[metric] });
    // Numbers like the tabs (11 / 19分); the bars' own value text keeps the unit (11回).
    const formatPart = (value: number) => (metric === 'time'
      ? formatTotalDuration(value, language)
      : Math.round(value).toLocaleString());
    const splitTotals = metric === 'songs'
      ? null
      : buckets.reduce<[number, number]>((totals, bucket) => {
        const parts = bucketParts(bucket, metric);
        return parts ? [totals[0] + parts[0], totals[1] + parts[1]] : totals;
      }, [0, 0]);
    const chartSeries = splitTotals
      ? [
        { key: 'manual', legend: t('手動 {value}', { value: formatPart(splitTotals[0]) }) },
        { key: 'auto', legend: t('自動 {value}', { value: formatPart(splitTotals[1]) }) },
      ]
      : undefined;
    body = (
      <div aria-busy={loading || undefined}>
        <MetricTabs<Metric>
          label={t('指標')}
          idPrefix="report-metric"
          panelId="report-chart"
          selected={metric}
          onSelect={setMetric}
          tabs={[
            {
              key: 'plays',
              label: metricLabels.plays,
              value: currentReport.totalQualifiedPlays.toLocaleString(),
              sub: `${t('再生開始')} ${currentReport.totalStarts.toLocaleString()}`,
            },
            { key: 'time', label: metricLabels.time, value: formatTotalDuration(currentReport.totalListenedSeconds, language) },
            { key: 'songs', label: metricLabels.songs, value: currentReport.uniqueSongCount.toLocaleString() },
            { key: 'finished', label: metricLabels.finished, value: currentReport.totalCompletes.toLocaleString() },
          ]}
        />
        <ReportChart
          panelId="report-chart"
          labelledBy={`report-metric-${metric}`}
          title={chartTitle}
          series={chartSeries}
          scale={metric === 'time' ? 'duration' : 'count'}
          formatValue={formatPart}
          bars={buckets.map((bucket, index) => {
            const value = bucketValue(bucket, metric);
            const parts = bucketParts(bucket, metric);
            return {
              key: bucket.key,
              value,
              parts: parts ?? undefined,
              label: formatBucketLabel(bucket.key, range.period, language, 'full'),
              axisLabel: showsAxisLabel(index, buckets.length, range.period)
                ? formatBucketLabel(bucket.key, range.period, language, 'axis')
                : undefined,
              valueText: formatMetric(value, metric),
              partsText: parts && value > 0
                ? t('手動 {manual} · 自動 {auto}', { manual: formatPart(parts[0]), auto: formatPart(parts[1]) })
                : undefined,
            };
          })}
        />

        {topSongs.length > 0 && (
          <section aria-labelledby="report-top-songs" className="mt-10">
            <h2 id="report-top-songs" className="m-0 mb-2 text-base leading-[22px] font-bold text-yt-text sm:text-xl sm:leading-7">
              {t('よく聴いた曲')}
            </h2>
            <ol className="m-0 -mx-2 list-none p-0">
              {topSongs.map((item, index) => {
                const playsText = formatPlays(item.qualifiedPlayCount, language);
                const rank = (
                  <span className="w-6 text-center text-sm leading-5 text-yt-text-secondary tabular-nums">{index + 1}</span>
                );
                return (
                  <li key={item.songId}>
                    {item.song ? (
                      <SongListRow
                        song={item.song}
                        size="sm"
                        leading={rank}
                        onActivate={() => navigate(watchPath(item.songId))}
                        trailing={<span className="px-2 text-sm leading-5 text-yt-text-secondary tabular-nums">{playsText}</span>}
                      />
                    ) : (
                      <div className="flex min-h-[72px] items-center gap-2 px-2 py-0.5">
                        {rank}
                        <span className="min-w-0 flex-1 truncate text-sm leading-5 font-medium text-yt-text">{item.songName}</span>
                        <span className="px-2 text-sm leading-5 text-yt-text-secondary tabular-nums">{playsText}</span>
                      </div>
                    )}
                  </li>
                );
              })}
            </ol>
            {currentReport.topSongsWithMeta.length > TOP_SONGS_COLLAPSED && (
              <Button variant="text" className="mt-2" onClick={() => setShowAllTopSongs(value => !value)}>
                {showAllTopSongs ? t('一部を表示') : t('もっと見る')}
              </Button>
            )}
          </section>
        )}

        {(autoPlaySession || autoQueueDecisionCount > 0) && (
          <details className="group/autoplay mt-10 rounded-card bg-yt-raised">
            <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-4 rounded-card px-4 text-base leading-6 font-medium text-yt-text [&::-webkit-details-marker]:hidden">
              {t('自動再生')}
              <ChevronDownIcon className="text-yt-text-secondary transition-transform duration-150 group-open/autoplay:rotate-180" />
            </summary>
            <div className="px-4 pb-4">
              {autoPlaySession ? (
                <dl className="m-0 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
                  <AutoplayStat label={t('再生回数')} value={autoPlaySession.autoPlayedCount.toLocaleString()} />
                  <AutoplayStat label={t('最後まで聴いた')} value={autoPlaySession.autoCompletedCount.toLocaleString()} />
                  <AutoplayStat
                    label={t('スキップ率')}
                    value={`${Math.round(autoPlaySession.autoSkippedCount / Math.max(1, autoPlaySession.autoCompletedCount + autoPlaySession.autoSkippedCount) * 100)}%`}
                  />
                  <AutoplayStat label={t('手動で変更')} value={autoPlaySession.manualOverrideCount.toLocaleString()} />
                </dl>
              ) : (
                <p className="m-0 text-sm leading-5 text-yt-text-secondary">{t('自動再生の記録はありません')}</p>
              )}
              {autoQueueDecisionCount > 0 && (
                <p className="m-0 mt-3 text-xs leading-[18px] text-yt-text-secondary tabular-nums">
                  {t('判断ログ {count}', { count: autoQueueDecisionCount.toLocaleString() })}
                </p>
              )}
            </div>
          </details>
        )}
      </div>
    );
  }

  return (
    <PageShell>
      <PageHeader
        title={t('レポート')}
        actions={isMobile ? moreMenu : <>{periodControl}{moreMenu}</>}
      />
      {isMobile && <div className="mb-4">{periodControl}</div>}
      {body}
    </PageShell>
  );
}

function AutoplayStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="truncate text-xs leading-4 text-yt-text-secondary">{label}</dt>
      <dd className="m-0 mt-0.5 text-base leading-6 font-medium text-yt-text tabular-nums">{value}</dd>
    </div>
  );
}
