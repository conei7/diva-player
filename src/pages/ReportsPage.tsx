import { useState, useEffect } from 'react';
import { getHistoryReport, type HistoryReport } from '../services/historyStats';
import { Link } from 'react-router-dom';

export default function ReportsPage() {
  const [period, setPeriod] = useState<'month' | 'year'>('month');
  const [key, setKey] = useState<string>('');
  const [report, setReport] = useState<HistoryReport | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    // 初期値設定
    const now = new Date();
    if (period === 'month') {
      setKey(`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`);
    } else {
      setKey(String(now.getFullYear()));
    }
  }, [period]);

  useEffect(() => {
    if (!key) return;
    setLoading(true);
    getHistoryReport({ period, key })
      .then(setReport)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [period, key]);

  const formatDuration = (seconds: number) => {
    const hours = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    return `${hours}時間 ${mins}分`;
  };

  return (
    <div className="flex flex-col h-full overflow-y-auto px-4 py-6 md:px-8 max-w-5xl mx-auto w-full pb-32">
      <div className="flex flex-col md:flex-row md:items-center justify-between mb-8 gap-4">
        <h1 className="text-3xl font-bold">
          <span className="glow-text text-cyan-400">Listening</span> Report
        </h1>
        <div className="flex gap-4">
          <select
            value={period}
            onChange={(e) => setPeriod(e.target.value as 'month' | 'year')}
            className="p-2 rounded-xl bg-black/50 border border-white/10 text-white"
          >
            <option value="month">月間レポート</option>
            <option value="year">年間レポート</option>
          </select>
          {period === 'month' ? (
            <input
              type="month"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              className="p-2 rounded-xl bg-black/50 border border-white/10 text-white"
            />
          ) : (
            <input
              type="number"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              className="p-2 rounded-xl bg-black/50 border border-white/10 text-white w-24"
            />
          )}
        </div>
      </div>

      {loading ? (
        <div className="text-center py-20 text-white/50">読み込み中...</div>
      ) : report ? (
        <div className="flex flex-col gap-8">
          {/* Overview Stats */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="glass p-4 rounded-2xl">
              <div className="text-sm text-white/50 mb-1">再生回数</div>
              <div className="text-2xl font-bold">{report.overview.totalStarts.toLocaleString()} 回</div>
            </div>
            <div className="glass p-4 rounded-2xl">
              <div className="text-sm text-white/50 mb-1">有効再生数</div>
              <div className="text-2xl font-bold">{report.overview.totalQualifiedPlays.toLocaleString()} 回</div>
            </div>
            <div className="glass p-4 rounded-2xl">
              <div className="text-sm text-white/50 mb-1">完走数</div>
              <div className="text-2xl font-bold">{report.overview.totalCompletes.toLocaleString()} 回</div>
            </div>
            <div className="glass p-4 rounded-2xl">
              <div className="text-sm text-white/50 mb-1">総再生時間</div>
              <div className="text-2xl font-bold">{formatDuration(report.overview.totalListenedSeconds)}</div>
            </div>
          </div>

          <div className="grid md:grid-cols-2 gap-8">
            {/* Top Songs */}
            <div className="glass p-6 rounded-2xl flex flex-col gap-4">
              <h2 className="text-xl font-bold border-b border-white/10 pb-2">Top Songs</h2>
              <div className="flex flex-col gap-2">
                {report.topSongsWithMeta.slice(0, 10).map((song, i) => (
                  <Link
                    key={song.songId}
                    to={`/watch?v=${song.songId}`}
                    className="flex items-center gap-3 p-2 hover:bg-white/5 rounded-xl transition-colors"
                  >
                    <div className="w-6 text-center font-bold text-white/50">{i + 1}</div>
                    <div className="w-12 h-12 rounded-lg bg-black/50 overflow-hidden shrink-0">
                      {song.thumbUrl && (
                        <img src={song.thumbUrl} alt={song.songName} className="w-full h-full object-cover" />
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="font-bold truncate">{song.songName}</div>
                      <div className="text-xs text-white/50 truncate">{song.artistString}</div>
                    </div>
                    <div className="text-right">
                      <div className="font-bold">{song.qualifiedPlayCount} 回</div>
                    </div>
                  </Link>
                ))}
                {report.topSongsWithMeta.length === 0 && (
                  <div className="text-white/50 text-center py-4">データがありません</div>
                )}
              </div>
            </div>

            {/* Top Artists */}
            <div className="flex flex-col gap-8">
              <div className="glass p-6 rounded-2xl">
                <h2 className="text-xl font-bold border-b border-white/10 pb-2 mb-4">Top Producers</h2>
                <div className="flex flex-col gap-2">
                  {report.topProducers.map((p, i) => (
                    <div key={p.id} className="flex justify-between items-center text-sm p-2 rounded hover:bg-white/5">
                      <div className="flex items-center gap-3">
                        <span className="text-white/50 w-4">{i + 1}</span>
                        <span className="font-bold">{p.name}</span>
                      </div>
                      <span className="text-cyan-400 font-mono">{p.count} pts</span>
                    </div>
                  ))}
                  {report.topProducers.length === 0 && <div className="text-white/50 text-center py-4">データがありません</div>}
                </div>
              </div>

              <div className="glass p-6 rounded-2xl">
                <h2 className="text-xl font-bold border-b border-white/10 pb-2 mb-4">Top Vocalists</h2>
                <div className="flex flex-col gap-2">
                  {report.topVocalists.map((v, i) => (
                    <div key={v.id} className="flex justify-between items-center text-sm p-2 rounded hover:bg-white/5">
                      <div className="flex items-center gap-3">
                        <span className="text-white/50 w-4">{i + 1}</span>
                        <span className="font-bold">{v.name}</span>
                      </div>
                      <span className="text-purple-400 font-mono">{v.count} pts</span>
                    </div>
                  ))}
                  {report.topVocalists.length === 0 && <div className="text-white/50 text-center py-4">データがありません</div>}
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
