import { useMemo, useState } from 'react';
import type { Song } from '../../types/vocadb';
import {
  analyzePlaylistHealth,
  PLAYLIST_HEALTH_ISSUE_LABELS,
  type PlaylistHealthIssueKind,
} from '../../utils/playlistHealth';

interface PlaylistHealthModalProps {
  songs: Song[];
  onClose: () => void;
  onRemove: (indexes: number[]) => void;
}

const ISSUE_ORDER: PlaylistHealthIssueKind[] = [
  'duplicate',
  'no-pv',
  'all-pv-disabled',
  'no-playable-pv',
];

export default function PlaylistHealthModal({ songs, onClose, onRemove }: PlaylistHealthModalProps) {
  const report = useMemo(() => analyzePlaylistHealth(songs), [songs]);
  const [selectedIndexes, setSelectedIndexes] = useState<Set<number>>(
    () => new Set(report.entries.map(entry => entry.index)),
  );

  const toggle = (index: number) => {
    setSelectedIndexes(current => {
      const next = new Set(current);
      if (next.has(index)) next.delete(index); else next.add(index);
      return next;
    });
  };

  const selectAll = () => setSelectedIndexes(new Set(report.entries.map(entry => entry.index)));
  const clearAll = () => setSelectedIndexes(new Set());

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm" role="presentation" onMouseDown={onClose}>
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="playlist-health-title"
        className="flex max-h-[min(720px,calc(100dvh-2rem))] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-white/10 bg-neutral-950 shadow-2xl"
        onMouseDown={event => event.stopPropagation()}
      >
        <header className="flex items-start justify-between gap-4 border-b border-white/10 p-5">
          <div>
            <p className="text-xs uppercase tracking-[0.16em] text-cyan-300/70">Playlist health</p>
            <h2 id="playlist-health-title" className="mt-1 text-xl font-semibold text-white">プレイリストの健全性</h2>
            <p className="mt-1 text-sm text-neutral-400">削除前に対象を確認できます。チェックを外した曲は残ります。</p>
          </div>
          <button type="button" onClick={onClose} className="rounded-full p-2 text-neutral-400 hover:bg-white/10 hover:text-white" aria-label="閉じる">✕</button>
        </header>

        <div className="grid grid-cols-2 gap-2 border-b border-white/10 p-4 sm:grid-cols-4">
          {ISSUE_ORDER.map(kind => (
            <div key={kind} className="rounded-xl border border-white/10 bg-white/[0.035] p-3">
              <p className="text-xs text-neutral-400">{PLAYLIST_HEALTH_ISSUE_LABELS[kind]}</p>
              <p className="mt-1 text-xl font-semibold text-white">{report.counts[kind]}</p>
            </div>
          ))}
        </div>

        {report.entries.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 p-12 text-center">
            <div className="text-4xl text-emerald-300">✓</div>
            <p className="font-medium text-white">問題は見つかりませんでした</p>
            <p className="text-sm text-neutral-400">{report.totalSongs}曲すべてに再生可能なPVがあります。</p>
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between gap-3 border-b border-white/10 px-5 py-3 text-xs text-neutral-400">
              <span>{selectedIndexes.size}曲を削除対象に選択中</span>
              <span className="flex gap-3">
                <button type="button" onClick={selectAll} className="text-cyan-300 hover:text-white">すべて選択</button>
                <button type="button" onClick={clearAll} className="hover:text-white">解除</button>
              </span>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-3">
              <div className="space-y-2">
                {report.entries.map(entry => (
                  <label key={`${entry.song.id}-${entry.index}`} className="flex cursor-pointer items-start gap-3 rounded-xl border border-white/10 bg-white/[0.025] p-3 hover:bg-white/[0.06]">
                    <input type="checkbox" checked={selectedIndexes.has(entry.index)} onChange={() => toggle(entry.index)} className="mt-1 h-4 w-4 accent-cyan-400" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-white">{entry.song.name}</span>
                      <span className="mt-1 flex flex-wrap gap-1.5">
                        {entry.issues.map(kind => <span key={kind} className="rounded-full bg-amber-300/10 px-2 py-0.5 text-[11px] text-amber-200">{PLAYLIST_HEALTH_ISSUE_LABELS[kind]}</span>)}
                      </span>
                    </span>
                    <span className="text-xs text-neutral-500">#{entry.index + 1}</span>
                  </label>
                ))}
              </div>
            </div>
          </>
        )}

        <footer className="flex items-center justify-end gap-2 border-t border-white/10 p-4">
          <button type="button" onClick={onClose} className="rounded-xl border border-white/10 px-4 py-2 text-sm text-neutral-300 hover:bg-white/10">閉じる</button>
          {report.entries.length > 0 && (
            <button
              type="button"
              disabled={selectedIndexes.size === 0}
              onClick={() => onRemove([...selectedIndexes].sort((a, b) => a - b))}
              className="rounded-xl bg-red-400/90 px-4 py-2 text-sm font-semibold text-black transition-opacity hover:bg-red-300 disabled:cursor-not-allowed disabled:opacity-40"
            >
              選択した{selectedIndexes.size}曲を削除
            </button>
          )}
        </footer>
      </section>
    </div>
  );
}

