import { useCallback, useEffect, useMemo, useState } from 'react';
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

export default function KnowledgeMapPage() {
  const ratings = useRatingStore(state => state.ratings);
  const [result, setResult] = useState<KnowledgeMapResponse | null>(null);
  const [platform, setPlatform] = useState<KnowledgeMapPlatform>('youtube');
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
  const rectangles = useMemo(
    () => data ? layoutKnowledgeMap(buildKnowledgeMapItems(data)) : [],
    [data],
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
    <main className="mx-auto w-full max-w-7xl px-4 py-6 pb-32 sm:px-6" data-testid="knowledge-map-page">
      <div className="mb-6 max-w-3xl">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-cyan-300">Your Vocal Synth Map</p>
        <h1 className="mt-1 text-2xl font-bold text-white sm:text-3xl">知ってる度マップ</h1>
        <p className="mt-2 text-sm leading-6 text-neutral-400">
          ボカロ曲全体の再生規模に対して、端末の再生履歴にある曲、または星1〜5で評価した曲が占める面積を表示します。YouTubeとニコニコは換算・合算せず、それぞれの再生数で集計します。
        </p>
      </div>

      <div className="mb-6 inline-flex min-h-11 rounded-xl border border-white/[0.08] bg-white/[0.03] p-1" role="group" aria-label="再生数のサービス">
        {(['youtube', 'nico'] as const).map(value => (
          <button
            key={value}
            type="button"
            onClick={() => setPlatform(value)}
            aria-pressed={platform === value}
            className={`min-w-32 rounded-lg px-4 py-2 text-sm font-semibold transition ${platform === value ? 'bg-white text-black' : 'text-neutral-400 hover:bg-white/[0.06] hover:text-white'}`}
          >
            {platformLabel(value)}
          </button>
        ))}
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
  rectangles,
  topKnown,
  topUnknown,
}: {
  result: KnowledgeMapResponse;
  data: PlatformKnowledgeMap;
  platform: KnowledgeMapPlatform;
  rectangles: KnowledgeMapRect[];
  topKnown: PlatformKnowledgeMap['tiles'];
  topUnknown: PlatformKnowledgeMap['tiles'];
}) {
  return (
    <>
      <section className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4" aria-label={`${platformLabel(platform)}の知ってる度`}>
        <Metric label="知ってる度" value={formatPercent(data.coverageRatio)} accent />
        <Metric label="知っている曲の再生規模" value={formatViews(data.knownViews)} />
        <Metric label={`${platformLabel(platform)}再生数の総量`} value={formatViews(data.totalViews)} />
        <Metric label="知っている曲" value={`${data.knownSongCount.toLocaleString()} / ${data.totalSongCount.toLocaleString()}曲`} />
      </section>

      <section className="overflow-hidden rounded-3xl border border-white/[0.08] bg-neutral-950 p-2 shadow-2xl sm:p-3">
        <div className="relative h-[460px] w-full overflow-hidden rounded-2xl bg-neutral-900 sm:h-[560px]" data-testid={`${platform}-knowledge-treemap`}>
          {rectangles.map((rect, index) => {
            const showFullLabel = rect.width >= 9 && rect.height >= 8;
            const showShortLabel = !showFullLabel && rect.width >= 4.5 && rect.height >= 4.5;
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
                {(showFullLabel || showShortLabel) && (
                  <span className="relative z-10 flex h-full min-w-0 flex-col justify-end overflow-hidden p-1.5 text-left sm:p-2">
                    <span className={`${showFullLabel ? 'text-xs sm:text-sm' : 'text-[9px]'} truncate font-bold text-white`}>{rect.known ? '✓ ' : ''}{rect.label}</span>
                    {showFullLabel && <span className="mt-0.5 truncate text-[10px] text-white/65">{rect.secondaryLabel || formatViews(rect.views)}</span>}
                    {showFullLabel && rect.secondaryLabel && <span className="text-[10px] text-white/75">{formatViews(rect.views)}</span>}
                  </span>
                )}
              </>
            );
            const title = `${rect.known ? '知っている' : 'まだ知らない'}: ${rect.label} — ${formatViews(rect.views)}`;
            return rect.songId ? (
              <Link key={rect.id} to={`/watch?v=${rect.songId}`} className="absolute overflow-hidden outline-none ring-inset focus-visible:ring-2 focus-visible:ring-white" style={style} title={title} aria-label={title}>
                {content}
              </Link>
            ) : (
              <div key={rect.id} className="absolute overflow-hidden" style={style} title={title} aria-label={title}>
                {content}
              </div>
            );
          })}
        </div>
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 px-2 pb-1 pt-3 text-xs text-neutral-400">
          <span className="inline-flex items-center gap-2"><span className={`h-3 w-3 rounded-sm ${platform === 'youtube' ? 'bg-rose-500' : 'bg-teal-400'}`} />履歴または星評価がある曲</span>
          <span className="inline-flex items-center gap-2"><span className="h-3 w-3 rounded-sm bg-neutral-600" />履歴・星評価がない曲</span>
          <span>長方形の面積＝{platformLabel(platform)}再生数</span>
        </div>
      </section>

      <section className="mt-6 grid gap-4 lg:grid-cols-2">
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
    <div className="rounded-2xl border border-white/[0.06] bg-white/[0.03] p-4">
      <h2 className="font-bold text-white">{title}</h2>
      {songs.length === 0 ? <p className="py-8 text-center text-sm text-neutral-500">{empty}</p> : (
        <ol className="mt-3 space-y-1">
          {songs.map((song, index) => (
            <li key={song.songId}>
              <Link to={`/watch?v=${song.songId}`} className="flex min-h-12 items-center gap-3 rounded-xl px-2 py-1.5 hover:bg-white/[0.05] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300">
                <span className="w-5 text-center text-xs text-neutral-600">{index + 1}</span>
                <span className="h-9 w-14 shrink-0 overflow-hidden rounded-md bg-neutral-800">{song.thumbUrl && <img src={song.thumbUrl} alt="" className="h-full w-full object-cover" />}</span>
                <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium text-neutral-200">{song.name}</span><span className="block truncate text-xs text-neutral-500">{song.artistString}</span></span>
                <span className="shrink-0 text-xs text-neutral-400">{formatViews(song.views)}</span>
              </Link>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
