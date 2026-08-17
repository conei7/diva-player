import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import {
  fetchKnowledgeMap,
  type KnowledgeMapPlatform,
  type KnowledgeMapResponse,
  type PlatformKnowledgeMap,
} from '../api/knowledgeMap';
import { getPlayedSongIds } from '../services/historyDatabase';
import { useRatingStore } from '../stores/ratingStore';
import { buildKnowledgeMapItems, layoutKnowledgeMap, type KnowledgeMapRect } from '../utils/knowledgeMap';
import { getRatedSongIds } from '../utils/ratedSongs';

type ViewMode = 'all' | 'known' | 'unknown';

const compactNumber = new Intl.NumberFormat('ja-JP', { notation: 'compact', maximumFractionDigits: 1 });

function formatViews(value: number): string {
  return `${compactNumber.format(Math.max(0, value))}回`;
}

function formatPercent(ratio: number): string {
  const percent = Math.max(0, Math.min(1, ratio)) * 100;
  return `${percent < 1 && percent > 0 ? percent.toFixed(2) : percent.toFixed(1)}%`;
}

function platformLabel(platform: KnowledgeMapPlatform): string {
  return platform === 'youtube' ? 'YouTube' : 'ニコニコ';
}

function tileBackground(rect: KnowledgeMapRect, platform: KnowledgeMapPlatform, index: number): string {
  if (rect.known) {
    return platform === 'youtube'
      ? `linear-gradient(145deg, hsl(${348 + index % 12} 78% 48%), hsl(${330 + index % 18} 65% 28%))`
      : `linear-gradient(145deg, hsl(${174 + index % 16} 72% 42%), hsl(${205 + index % 16} 70% 24%))`;
  }
  return rect.aggregate
    ? 'linear-gradient(145deg, rgba(55,65,81,.92), rgba(24,24,27,.98))'
    : 'linear-gradient(145deg, rgba(82,82,91,.9), rgba(39,39,42,.98))';
}

const VIEW_MODES: { value: ViewMode; label: string }[] = [
  { value: 'all', label: '全体' },
  { value: 'known', label: '知っている曲' },
  { value: 'unknown', label: 'まだ知らない曲' },
];

export default function KnowledgeMapPage() {
  const ratings = useRatingStore(state => state.ratings);
  const [result, setResult] = useState<KnowledgeMapResponse | null>(null);
  const [platform, setPlatform] = useState<KnowledgeMapPlatform>('youtube');
  const [viewMode, setViewMode] = useState<ViewMode>('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const ratedSongIds = useMemo(() => getRatedSongIds(ratings), [ratings]);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setLoading(true);
    setError('');
    getPlayedSongIds()
      .then(playedSongIds => {
        // Explicit ratings stay inside the API's 50,000-id limit even for an
        // unusually large playback history; overlapping IDs still count once.
        const knownSongIds = new Set(ratedSongIds);
        playedSongIds.forEach(id => knownSongIds.add(id));
        return fetchKnowledgeMap(knownSongIds, controller.signal);
      })
      .then(next => { if (active) setResult(next); })
      .catch(requestError => {
        if (active && requestError instanceof Error && requestError.name !== 'AbortError') {
          setError('知ってる度を集計できませんでした。データAPIへの接続を確認して再試行してください。');
        }
      })
      .finally(() => { if (active) setLoading(false); });
    return () => {
      active = false;
      controller.abort();
    };
  }, [ratedSongIds, reloadKey]);

  const data = result?.[platform] ?? null;
  const allItems = useMemo(
    () => data ? buildKnowledgeMapItems(data) : [],
    [data],
  );
  const filteredItems = useMemo(
    () => viewMode === 'all'
      ? allItems
      : allItems.filter(item => viewMode === 'known' ? item.known : !item.known),
    [allItems, viewMode],
  );
  const rectangles = useMemo(
    () => layoutKnowledgeMap(filteredItems),
    [filteredItems],
  );
  const topKnown = useMemo(
    () => data?.tiles.filter(tile => tile.known).sort((left, right) => right.views - left.views).slice(0, 8) ?? [],
    [data],
  );
  const topUnknown = useMemo(
    () => data?.tiles.filter(tile => !tile.known).sort((left, right) => right.views - left.views).slice(0, 8) ?? [],
    [data],
  );
  const retry = useCallback(() => setReloadKey(key => key + 1), []);

  return (
    <main className="mx-auto w-full max-w-7xl px-3 py-4 pb-32 sm:px-6 sm:py-6" data-testid="knowledge-map-page">
      <div className="mb-5 max-w-3xl sm:mb-6">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-cyan-300">Your Vocal Synth Map</p>
        <h1 className="mt-1 text-2xl font-bold text-white sm:text-3xl">知ってる度マップ</h1>
        <p className="mt-2 text-sm leading-6 text-neutral-400">
          ボカロ曲全体の再生規模に対して、端末の再生履歴にある曲、または星1〜5で評価した曲が占める面積を表示します。YouTubeとニコニコは換算・合算せず、それぞれの再生数で集計します。
        </p>
      </div>

      <div className="mb-3 grid min-h-11 w-full grid-cols-2 rounded-xl border border-white/[0.08] bg-white/[0.03] p-1 sm:inline-flex sm:w-auto" role="group" aria-label="再生数のサービス">
        {(['youtube', 'nico'] as const).map(value => (
          <button
            key={value}
            type="button"
            onClick={() => setPlatform(value)}
            aria-pressed={platform === value}
            className={`min-h-10 rounded-lg px-4 py-2 text-sm font-semibold transition sm:min-w-32 ${platform === value ? 'bg-white text-black' : 'text-neutral-400 hover:bg-white/[0.06] hover:text-white'}`}
          >
            {platformLabel(value)}
          </button>
        ))}
      </div>

      <div className="mb-5 grid grid-cols-3 gap-1.5 sm:mb-6 sm:flex sm:flex-wrap sm:items-center" role="group" aria-label="マップ表示">
        {VIEW_MODES.map(({ value, label }) => (
          <button
            key={value}
            type="button"
            onClick={() => setViewMode(value)}
            aria-pressed={viewMode === value}
            className={`min-h-10 rounded-lg px-1.5 py-1.5 text-xs font-medium leading-tight transition sm:min-h-0 sm:px-3 ${
              viewMode === value
                ? 'bg-white/[0.12] text-white ring-1 ring-white/20'
                : 'text-neutral-500 hover:bg-white/[0.05] hover:text-neutral-300'
            }`}
          >
            {label}
          </button>
        ))}
        {viewMode !== 'all' && (
          <span className="col-span-3 mt-0.5 text-[11px] text-neutral-600 sm:col-auto sm:ml-2 sm:mt-0">
            マップをフィルター中 — タイルが拡大されています
          </span>
        )}
      </div>

      {loading ? (
        <div className="rounded-3xl border border-white/[0.06] bg-white/[0.03] py-24 text-center text-neutral-400" aria-busy="true">再生履歴・評価と曲全体を集計しています…</div>
      ) : error ? (
        <div className="rounded-2xl border border-red-400/20 bg-red-400/10 p-6 text-red-100" role="alert">
          <p>{error}</p>
          <button type="button" onClick={retry} className="mt-4 rounded-lg bg-white px-4 py-2 text-sm font-semibold text-black">再試行</button>
        </div>
      ) : result && data ? (
        <KnowledgeMapContent
          result={result}
          data={data}
          platform={platform}
          viewMode={viewMode}
          rectangles={rectangles}
          topKnown={topKnown}
          topUnknown={topUnknown}
        />
      ) : null}
    </main>
  );
}

function KnowledgeMapContent({
  result,
  data,
  platform,
  viewMode,
  rectangles,
  topKnown,
  topUnknown,
}: {
  result: KnowledgeMapResponse;
  data: PlatformKnowledgeMap;
  platform: KnowledgeMapPlatform;
  viewMode: ViewMode;
  rectangles: KnowledgeMapRect[];
  topKnown: PlatformKnowledgeMap['tiles'];
  topUnknown: PlatformKnowledgeMap['tiles'];
}) {
  const [hovered, setHovered] = useState<{ rect: KnowledgeMapRect; x: number; y: number } | null>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);

  // Position tooltip directly via DOM to avoid per-pixel re-renders.
  useEffect(() => {
    if (!hovered) return;
    const positionTooltip = (clientX: number, clientY: number) => {
      const el = tooltipRef.current;
      if (!el) return;
      let left = clientX + 14;
      let top = clientY + 14;
      const rect = el.getBoundingClientRect();
      if (left + rect.width > window.innerWidth - 8) left = clientX - rect.width - 8;
      if (top + rect.height > window.innerHeight - 8) top = clientY - rect.height - 8;
      left = Math.max(8, left);
      top = Math.max(8, top);
      el.style.left = `${left}px`;
      el.style.top = `${top}px`;
    };
    positionTooltip(hovered.x, hovered.y);
    const handleMouseMove = (e: MouseEvent) => positionTooltip(e.clientX, e.clientY);
    document.addEventListener('mousemove', handleMouseMove, { passive: true });
    return () => document.removeEventListener('mousemove', handleMouseMove);
  }, [hovered]);

  return (
    <>
      <section className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4" aria-label={`${platformLabel(platform)}の知ってる度`}>
        <Metric label="知ってる度" value={formatPercent(data.coverageRatio)} accent />
        <Metric label="知っている曲の再生規模" value={formatViews(data.knownViews)} />
        <Metric label={`${platformLabel(platform)}再生数の総量`} value={formatViews(data.totalViews)} />
        <Metric label="知っている曲" value={`${data.knownSongCount.toLocaleString()} / ${data.totalSongCount.toLocaleString()}曲`} />
      </section>

      <section className="overflow-hidden rounded-2xl border border-white/[0.08] bg-neutral-950 p-1.5 shadow-2xl sm:rounded-3xl sm:p-3">
        <div
          className="relative h-[420px] w-full overflow-hidden rounded-xl bg-neutral-900 sm:h-[560px] sm:rounded-2xl"
          data-testid={`${platform}-knowledge-treemap`}
          onMouseLeave={() => setHovered(null)}
        >
          {rectangles.length === 0 ? (
            <div className="flex h-full items-center justify-center text-sm text-neutral-500">
              {viewMode === 'known' ? '知っている曲がこのサービスにありません' : viewMode === 'unknown' ? '未再生の曲がありません' : '表示する曲がありません'}
            </div>
          ) : rectangles.map((rect, index) => {
            const showFullLabel = rect.width >= 8 && rect.height >= 7;
            const showShortLabel = !showFullLabel && rect.width >= 3.5 && rect.height >= 3.5;
            const showDot = !showFullLabel && !showShortLabel && rect.width >= 1.5 && rect.height >= 1.5;
            const style = {
              left: `${rect.x}%`,
              top: `${rect.y}%`,
              width: `${rect.width}%`,
              height: `${rect.height}%`,
              background: tileBackground(rect, platform, index),
            };
            const content = (
              <>
                {rect.thumbUrl && <img src={rect.thumbUrl} alt="" className={`absolute inset-0 h-full w-full object-cover ${rect.known ? 'opacity-30' : 'opacity-10'} mix-blend-luminosity`} />}
                <span className="absolute inset-0 border border-black/35" />
                {rect.known && <span className={`absolute inset-y-0 left-0 w-[3px] ${platform === 'youtube' ? 'bg-rose-400/80' : 'bg-teal-400/80'}`} />}
                {(showFullLabel || showShortLabel) && (
                  <span className="relative z-10 flex h-full min-w-0 flex-col justify-end overflow-hidden p-1.5 text-left sm:p-2">
                    <span className={`${showFullLabel ? 'text-xs sm:text-sm' : 'text-[9px]'} truncate font-bold text-white`}>{rect.label}</span>
                    {showFullLabel && <span className="mt-0.5 truncate text-[10px] text-white/65">{rect.secondaryLabel || formatViews(rect.views)}</span>}
                    {showFullLabel && rect.secondaryLabel && <span className="text-[10px] text-white/75">{formatViews(rect.views)}</span>}
                  </span>
                )}
                {showDot && (
                  <span className="absolute inset-0 flex items-center justify-center">
                    <span className={`h-1 w-1 rounded-full ${rect.known ? (platform === 'youtube' ? 'bg-rose-400/70' : 'bg-teal-400/70') : 'bg-neutral-500/50'}`} />
                  </span>
                )}
              </>
            );
            const title = `${rect.known ? '知っている' : 'まだ知らない'}: ${rect.label} — ${formatViews(rect.views)}`;
            return rect.songId ? (
              <Link
                key={rect.id}
                to={`/watch?v=${rect.songId}`}
                className="absolute overflow-hidden outline-none ring-inset transition-shadow duration-100 hover:ring-2 hover:ring-white/60 focus-visible:ring-2 focus-visible:ring-white"
                style={style}
                aria-label={title}
                onMouseEnter={(e) => setHovered({ rect, x: e.clientX, y: e.clientY })}
                onFocus={(e) => {
                  const bounds = e.currentTarget.getBoundingClientRect();
                  setHovered({ rect, x: bounds.left + bounds.width / 2, y: bounds.bottom });
                }}
                onBlur={() => setHovered(null)}
              >
                {content}
              </Link>
            ) : (
              <div
                key={rect.id}
                className="absolute overflow-hidden transition-shadow duration-100 hover:ring-1 hover:ring-inset hover:ring-white/30"
                style={style}
                aria-label={title}
                onMouseEnter={(e) => setHovered({ rect, x: e.clientX, y: e.clientY })}
              >
                {content}
              </div>
            );
          })}
        </div>
        <div className="grid gap-2 px-2 pb-1 pt-3 text-[11px] text-neutral-400 sm:flex sm:flex-wrap sm:items-center sm:gap-x-5 sm:gap-y-2 sm:text-xs">
          <span className="inline-flex items-center gap-2"><span className={`h-3 w-3 rounded-sm ${platform === 'youtube' ? 'bg-rose-500' : 'bg-teal-400'}`} />履歴または星評価がある曲</span>
          <span className="inline-flex items-center gap-2"><span className="h-3 w-3 rounded-sm bg-neutral-600" />履歴・星評価がない曲</span>
          <span>長方形の面積＝{platformLabel(platform)}再生数</span>
        </div>
      </section>

      {/* Tooltip rendered outside the overflow container for correct visibility */}
      {hovered && (
        <div
          ref={tooltipRef}
          role="tooltip"
          data-testid="knowledge-map-tooltip"
          className="pointer-events-none fixed z-50 max-w-[260px] rounded-xl border border-white/[0.12] bg-neutral-900/95 px-3.5 py-2.5 shadow-2xl backdrop-blur-sm"
          style={{ left: hovered.x + 14, top: hovered.y + 14 }}
        >
          {hovered.rect.thumbUrl && (
            <img src={hovered.rect.thumbUrl} alt="" className="mb-2 h-16 w-full rounded-lg object-cover" />
          )}
          <p className="truncate text-sm font-bold text-white">{hovered.rect.label}</p>
          {hovered.rect.secondaryLabel && <p className="mt-0.5 truncate text-xs text-neutral-400">{hovered.rect.secondaryLabel}</p>}
          <div className="mt-1.5 flex items-center gap-2">
            <span className="text-xs font-medium text-neutral-200">{formatViews(hovered.rect.views)}</span>
            <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${
              hovered.rect.known
                ? platform === 'youtube' ? 'bg-rose-500/20 text-rose-300' : 'bg-teal-500/20 text-teal-300'
                : 'bg-neutral-700/50 text-neutral-400'
            }`}>
              {hovered.rect.known ? '知っている' : 'まだ知らない'}
            </span>
          </div>
          {hovered.rect.songId && <p className="mt-1 text-[10px] text-neutral-600">クリックで曲ページへ</p>}
        </div>
      )}

      <section className="mt-5 grid min-w-0 gap-3 sm:mt-6 sm:gap-4 lg:grid-cols-2">
        <SongRanking title="知っている曲の上位" songs={topKnown} empty="このサービスで再生数を取得できた履歴・評価済み曲はありません。" />
        <SongRanking title="まだ知らない上位曲" songs={topUnknown} empty="表示対象の上位曲はすべて履歴または星評価に含まれています。" />
      </section>

      <p className="mt-5 text-xs leading-5 text-neutral-500">
        対象は発見品質条件を満たす{result.eligibleSongCount.toLocaleString()}曲です。履歴・評価から抽出した既知曲{result.historySongCount.toLocaleString()}曲のうち{result.matchedHistorySongCount.toLocaleString()}曲が対象に一致しました。曲ごとの上位表示に入りきらない分も「その他」として面積へ含めています。履歴と評価は端末内に保持され、重複除去した曲IDだけをこの集計時に送信し保存しません。星の数は送信しません。
      </p>
    </>
  );
}

function Metric({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className={`rounded-2xl border p-4 ${accent ? 'border-cyan-300/20 bg-cyan-300/[0.08]' : 'border-white/[0.06] bg-white/[0.03]'}`}>
      <p className="text-xs text-neutral-500">{label}</p>
      <p className={`mt-1 font-bold ${accent ? 'text-2xl text-cyan-200' : 'text-base text-white sm:text-lg'}`}>{value}</p>
    </div>
  );
}

function SongRanking({ title, songs, empty }: { title: string; songs: PlatformKnowledgeMap['tiles']; empty: string }) {
  return (
    <div className="min-w-0 overflow-hidden rounded-2xl border border-white/[0.06] bg-white/[0.03] p-3 sm:p-4" data-testid="knowledge-map-ranking">
      <h2 className="font-bold text-white">{title}</h2>
      {songs.length === 0 ? <p className="py-8 text-center text-sm text-neutral-500">{empty}</p> : (
        <ol className="mt-3 space-y-1">
          {songs.map((song, index) => (
            <li key={song.songId}>
              <Link to={`/watch?v=${song.songId}`} className="grid min-h-14 min-w-0 grid-cols-[1.25rem_3rem_minmax(0,1fr)] items-center gap-x-2 rounded-xl px-1 py-1.5 hover:bg-white/[0.05] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300 sm:min-h-12 sm:grid-cols-[1.25rem_3.5rem_minmax(0,1fr)_auto] sm:gap-x-3 sm:px-2">
                <span className="w-5 text-center text-xs text-neutral-600">{index + 1}</span>
                <span className="h-9 w-12 overflow-hidden rounded-md bg-neutral-800 sm:w-14">{song.thumbUrl && <img src={song.thumbUrl} alt="" className="h-full w-full object-cover" />}</span>
                <span className="min-w-0"><span className="block truncate text-sm font-medium text-neutral-200">{song.name}</span><span className="block truncate text-xs text-neutral-500">{song.artistString}</span><span className="mt-0.5 block text-[11px] text-neutral-400 sm:hidden">{formatViews(song.views)}</span></span>
                <span className="hidden shrink-0 text-xs text-neutral-400 sm:block">{formatViews(song.views)}</span>
              </Link>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
