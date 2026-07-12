import { Fragment, useMemo, useState } from 'react';
import { useRecommendationDebugStore } from '../../stores/recommendationDebugStore';
import type { RecommendationDebugSnapshot, RecommendationDebugSurface } from '../../types/recommendationDebug';

const surfaceLabels: Record<RecommendationDebugSurface, string> = {
  home: 'トップ',
  watch: '曲ページ',
  autoplay: '自動再生',
};

export default function RecommendationDebugPanel() {
  const enabled = useRecommendationDebugStore(state => state.enabled);
  const snapshots = useRecommendationDebugStore(state => state.snapshots);
  const clearSnapshots = useRecommendationDebugStore(state => state.clearSnapshots);
  const [open, setOpen] = useState(false);
  const [surface, setSurface] = useState<'all' | RecommendationDebugSurface>('all');
  const [showUnselected, setShowUnselected] = useState(true);

  const filteredSnapshots = useMemo(
    () => surface === 'all' ? snapshots : snapshots.filter(snapshot => snapshot.surface === surface),
    [snapshots, surface],
  );

  if (!enabled) return null;

  const exportJson = () => {
    const content = JSON.stringify(filteredSnapshots, null, 2);
    const blob = new Blob([content], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `diva-recommendation-debug-${Date.now()}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <>
      <button
        type="button"
        className="fixed right-4 bottom-24 z-[80] rounded-full px-3 py-2 text-xs font-semibold shadow-lg"
        style={{ background: 'var(--color-accent-cyan)', color: 'var(--color-bg-primary)' }}
        onClick={() => setOpen(true)}
      >
        推薦デバッグ ({snapshots.length})
      </button>

      {open && (
        <div className="fixed inset-0 z-[90] flex justify-end" role="dialog" aria-label="推薦デバッグ">
          <button
            type="button"
            aria-label="推薦デバッグを閉じる"
            className="absolute inset-0 bg-black/50"
            onClick={() => setOpen(false)}
          />
          <section
            className="relative h-full w-full max-w-5xl overflow-y-auto p-4 shadow-2xl"
            style={{ background: 'var(--color-bg-primary)', color: 'var(--color-text-primary)' }}
          >
            <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="text-lg font-bold">推薦デバッグ</h2>
                <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                  通常の推薦順位は変更せず、計算内訳だけを表示しています。
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <select
                  value={surface}
                  onChange={event => setSurface(event.target.value as 'all' | RecommendationDebugSurface)}
                  className="rounded border px-2 py-1 text-xs"
                  style={{ background: 'var(--color-surface)', borderColor: 'var(--color-border)' }}
                >
                  <option value="all">全ての推薦面</option>
                  <option value="home">トップ</option>
                  <option value="watch">曲ページ</option>
                  <option value="autoplay">自動再生</option>
                </select>
                <label className="flex items-center gap-1 text-xs">
                  <input type="checkbox" checked={showUnselected} onChange={event => setShowUnselected(event.target.checked)} />
                  未採用も表示
                </label>
                <button type="button" className="rounded border px-2 py-1 text-xs" onClick={exportJson}>JSON保存</button>
                <button type="button" className="rounded border px-2 py-1 text-xs" onClick={clearSnapshots}>消去</button>
                <button type="button" className="rounded border px-2 py-1 text-xs" onClick={() => setOpen(false)}>閉じる</button>
              </div>
            </div>

            {filteredSnapshots.length === 0 ? (
              <p className="rounded border p-4 text-sm" style={{ borderColor: 'var(--color-border)' }}>
                推薦リクエストを発生させると、ここに計算内訳が表示されます。
              </p>
            ) : (
              <div className="space-y-4">
                {filteredSnapshots.slice().reverse().map(snapshot => (
                  <SnapshotSection key={snapshot.id} snapshot={snapshot} showUnselected={showUnselected} />
                ))}
              </div>
            )}
          </section>
        </div>
      )}
    </>
  );
}

function SnapshotSection({
  snapshot,
  showUnselected,
}: {
  snapshot: RecommendationDebugSnapshot;
  showUnselected: boolean;
}) {
  const [expandedSongId, setExpandedSongId] = useState<number | null>(null);
  const rows = showUnselected ? snapshot.trace : snapshot.trace.filter(item => item.status === 'selected');
  return (
    <section className="rounded-xl border p-3" style={{ borderColor: 'var(--color-border)', background: 'var(--color-surface)' }}>
      <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 className="font-semibold">{surfaceLabels[snapshot.surface]}</h3>
        <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
          {new Date(snapshot.generatedAt).toLocaleTimeString('ja-JP')} / 候補 {snapshot.candidateCount} / 採用 {snapshot.selectedCount}
        </span>
        <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
          seed: {snapshot.seedSongIds.join(', ') || '-'} / bias: {snapshot.familiarityBias.toFixed(2)}
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[900px] text-left text-xs">
          <thead style={{ color: 'var(--color-text-muted)' }}>
            <tr>
              <th className="px-2 py-1">順位</th>
              <th className="px-2 py-1">曲</th>
              <th className="px-2 py-1">候補源</th>
              <th className="px-2 py-1">Evidence</th>
              <th className="px-2 py-1">好み</th>
              <th className="px-2 py-1">既知調整</th>
              <th className="px-2 py-1">P減点</th>
              <th className="px-2 py-1">歌声減点</th>
              <th className="px-2 py-1">最終</th>
              <th className="px-2 py-1">状態</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(item => (
              <Fragment key={item.songId}>
              <tr
                className="cursor-pointer border-t align-top hover:bg-white/5"
                style={{ borderColor: 'var(--color-border)' }}
                onClick={() => setExpandedSongId(current => current === item.songId ? null : item.songId)}
              >
                <td className="px-2 py-2">{item.selectedRank ?? '-'}</td>
                <td className="max-w-[240px] px-2 py-2">
                  <div className="truncate" title={item.songName}>{item.songName}</div>
                  <div style={{ color: 'var(--color-text-muted)' }}>#{item.songId}</div>
                </td>
                <td className="px-2 py-2">{item.sources.map(source => `${source.source}#${source.sourceRank}`).join(', ')}</td>
                <td className="px-2 py-2">{item.evidence.toFixed(3)}</td>
                <td className="px-2 py-2">{item.preference?.finalScore.toFixed(3) ?? '-'}</td>
                <td className="px-2 py-2">{item.familiarityAdjustment.toFixed(3)}</td>
                <td className="px-2 py-2">-{item.producerPenalty.toFixed(3)}</td>
                <td className="px-2 py-2">-{item.vocalistPenalty.toFixed(3)}</td>
                <td className="px-2 py-2 font-semibold">{item.finalScore?.toFixed(3) ?? '-'}</td>
                <td className="px-2 py-2">{item.status === 'selected' ? '採用' : '未採用'}<br /><span style={{ color: 'var(--color-text-muted)' }}>{item.reason}</span></td>
              </tr>
              {expandedSongId === item.songId && (
                <tr style={{ borderColor: 'var(--color-border)' }}>
                  <td colSpan={10} className="px-3 py-3">
                    <div className="grid gap-3 md:grid-cols-2">
                      <div>
                        <h4 className="mb-1 font-semibold">候補源の内訳</h4>
                        {item.sources.map(source => (
                          <div key={`${source.source}-${source.sourceRank}`} className="text-xs">
                            {source.source} #{source.sourceRank}: {source.sourceWeight.toFixed(2)} × {source.rankSignal.toFixed(3)} = {source.evidenceContribution.toFixed(3)}
                          </div>
                        ))}
                      </div>
                      <div>
                        <h4 className="mb-1 font-semibold">好み補正の内訳</h4>
                        <div className="text-xs">基礎値: {item.preference?.baseScore.toFixed(3) ?? '-'}</div>
                        <div className="text-xs">再聴補正: ×{item.preference?.recencyMultiplier.toFixed(3) ?? '-'}</div>
                        <div className="text-xs">プレイリスト: ×{item.preference?.playlistMultiplier.toFixed(3) ?? '-'}</div>
                        <div className="text-xs">評価: ×{item.preference?.ratingMultiplier.toFixed(3) ?? '-'}</div>
                        <div className="text-xs">暗黙フィードバック: ×{item.preference?.implicitFeedback.multiplier.toFixed(3) ?? '-'}</div>
                        <div className="text-xs">VocaDB人気: ×{item.preference?.popularityMultiplier.toFixed(3) ?? '-'}</div>
                      </div>
                    </div>
                  </td>
                </tr>
              )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
