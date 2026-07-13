import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { getHistoryReport, type HistoryReport } from '../services/historyStats';

function currentKey(period: 'month' | 'year'): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit' }).formatToParts(new Date());
  const year = parts.find(part => part.type === 'year')?.value ?? String(new Date().getFullYear());
  if (period === 'year') return year;
  return `${year}-${parts.find(part => part.type === 'month')?.value ?? '01'}`;
}

function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${hours}時間${String(minutes).padStart(2, '0')}分`;
}

export default function ReportsPage() {
  const [period, setPeriod] = useState<'month' | 'year'>('month');
  const [key, setKey] = useState(() => currentKey('month'));
  const [report, setReport] = useState<HistoryReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    const next = currentKey(period);
    setKey(next);
  }, [period]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    getHistoryReport(period, key)
      .then(next => { if (active) setReport(next); })
      .catch(() => { if (active) setError('レポートを読み込めませんでした。'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [period, key]);

  const maxBucket = useMemo(() => Math.max(...(report?.buckets.map(bucket => bucket.starts) ?? [0]), 1), [report]);
  const manualStarts = report?.manualPlayCount ?? 0;
  const autoStarts = report?.autoPlayCount ?? 0;

  return (
    <main className="w-full max-w-5xl mx-auto px-4 py-6 pb-32 overflow-y-auto">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
        <h1 className="text-2xl font-bold">リスニングレポート</h1>
        <div className="flex flex-wrap gap-2">
          <select value={period} onChange={event => setPeriod(event.target.value as 'month' | 'year')} className="rounded-lg px-3 py-2 bg-black/30 border border-white/10">
            <option value="month">月間</option><option value="year">年間</option>
          </select>
          {period === 'month'
            ? <input type="month" value={key} onChange={event => setKey(event.target.value)} className="rounded-lg px-3 py-2 bg-black/30 border border-white/10" />
            : <input type="number" min="2000" max="2100" value={key} onChange={event => setKey(event.target.value)} className="rounded-lg px-3 py-2 bg-black/30 border border-white/10 w-28" />}
        </div>
      </div>
      {loading && <p className="py-20 text-center text-white/60">集計中…</p>}
      {!loading && error && <p className="py-20 text-center text-red-300">{error}</p>}
      {!loading && !error && report && (
        <>
          <section className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-6">
            <Metric label="開始" value={`${report.totalStarts.toLocaleString()}回`} />
            <Metric label="有効再生" value={`${report.totalQualifiedPlays.toLocaleString()}回`} />
            <Metric label="曲数" value={`${report.uniqueSongCount.toLocaleString()}曲`} />
            <Metric label="完走" value={`${report.totalCompletes.toLocaleString()}回`} />
            <Metric label="総再生時間" value={formatDuration(report.totalListenedSeconds)} />
          </section>
          <section className="rounded-2xl p-4 mb-6" style={{ background: 'var(--color-bg-card)' }}>
            <div className="flex items-center justify-between mb-3"><h2 className="font-bold">{period === 'month' ? '日別' : '月別'}の再生開始</h2><span className="text-xs text-white/50">手動 {manualStarts} / 自動 {autoStarts}</span></div>
            <div className="h-40 flex items-end gap-1 overflow-x-auto">
              {report.buckets.map(bucket => <div key={bucket.key} className="h-full min-w-8 flex flex-col items-center justify-end gap-1"><span className="text-[10px] text-white/60">{bucket.starts}</span><div className="w-full rounded-t bg-cyan-400" style={{ height: `${Math.max(3, bucket.starts / maxBucket * 100)}%` }} title={`${bucket.key}: ${bucket.starts}回`} /><span className="text-[9px] text-white/50 [writing-mode:vertical-rl]">{bucket.key.slice(period === 'month' ? 5 : 0)}</span></div>)}
              {report.buckets.length === 0 && <p className="w-full text-center self-center text-white/50">データがありません</p>}
            </div>
          </section>
          <section className="rounded-2xl p-4" style={{ background: 'var(--color-bg-card)' }}>
            <h2 className="font-bold mb-3">よく聴いた曲</h2>
            <div className="flex flex-col gap-1">
              {report.topSongsWithMeta.slice(0, 20).map((song, index) => <Link key={song.songId} to={`/watch?v=${song.songId}`} className="flex items-center gap-3 p-2 rounded-lg hover:bg-white/5"><span className="w-6 text-center text-white/50">{index + 1}</span><div className="w-12 h-8 rounded overflow-hidden bg-black/30 shrink-0">{song.thumbUrl && <img src={song.thumbUrl} alt="" className="w-full h-full object-cover" />}</div><span className="min-w-0 flex-1 truncate">{song.songName}</span><span className="text-sm text-white/60">{song.qualifiedPlayCount}回</span></Link>)}
              {report.topSongsWithMeta.length === 0 && <p className="text-center text-white/50 py-4">データがありません</p>}
            </div>
          </section>
        </>
      )}
    </main>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="rounded-xl p-3" style={{ background: 'var(--color-bg-card)' }}><p className="text-xs text-white/50">{label}</p><p className="font-bold mt-1 text-sm md:text-base">{value}</p></div>;
}
