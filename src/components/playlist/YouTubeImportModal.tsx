/**
 * YouTubeImportModal
 *
 * YouTube プレイリスト URL からビデオIDを取得し、
 * VocaDB で一致する曲を検索してプレイリストへインポートする。
 *
 * 外部 API: Invidious (inv.nadeko.net) を Viteプロキシ経由で使用。
 */

import { useState } from 'react';
import type { Song } from '../../types/vocadb';

interface Props {
  onClose: () => void;
  onImport: (songs: Song[]) => void;
}

interface InvidiousVideo {
  videoId: string;
  title: string;
}

interface InvidiousPlaylist {
  title: string;
  videos: InvidiousVideo[];
}

// 開発時は Vite プロキシ (/invidious-api) を経由してCORSを回避。
// 本番環境ではブラウザから直接アクセス（クロスオリジン要求なし）。
const INVIDIOUS_PROXY = '/invidious-api';
const VOCADB_BASE    = 'https://vocadb.net/api';

function extractPlaylistId(url: string): string | null {
  try {
    const u = new URL(url);
    return u.searchParams.get('list');
  } catch {
    // plain ID
    if (/^PL[A-Za-z0-9_-]{16,}$/.test(url.trim())) return url.trim();
    return null;
  }
}

async function fetchPlaylistVideos(listId: string, onProgress?: (loaded: number) => void): Promise<string[]> {
  const seen = new Set<string>();
  const ids: string[] = [];
  const MAX_PAGES = 50; // 安全上限

  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await fetch(`${INVIDIOUS_PROXY}/api/v1/playlists/${encodeURIComponent(listId)}?page=${page}`);
    if (!res.ok) {
      if (page === 1) throw new Error(`YouTubeプレイリストの取得に失敗しました (HTTP ${res.status})`);
      break;
    }
    const data: InvidiousPlaylist = await res.json();
    const videos = data.videos ?? [];
    if (videos.length === 0) break; // 空ページ = 終端

    for (const v of videos) {
      if (v.videoId && !seen.has(v.videoId)) {
        seen.add(v.videoId);
        ids.push(v.videoId);
      }
    }
    onProgress?.(ids.length);
  }
  return ids;
}

async function fetchVocadbByYouTubeId(videoId: string): Promise<Song | null> {
  const res = await fetch(
    `${VOCADB_BASE}/songs/byPv?pvService=Youtube&pvId=${encodeURIComponent(videoId)}&fields=PVs,Artists`
  );
  if (res.status === 404) return null;
  if (!res.ok) return null;
  const data = await res.json();
  if (!data || !data.id) return null;
  // Original・リミックス・グッズ以外は無視（DramaPV, MusicPV, Otherも除外）
  const excludedTypes = ['DramaPV', 'MusicPV', 'Other'];
  if (excludedTypes.includes(data.songType)) return null;
  return data as Song;
}

export default function YouTubeImportModal({ onClose, onImport }: Props) {
  const [url, setUrl] = useState('');
  const [phase, setPhase] = useState<'idle' | 'fetching' | 'matching' | 'done' | 'error'>('idle');
  const [log, setLog] = useState<string[]>([]);
  const [songs, setSongs] = useState<Song[]>([]);
  const [unmatched, setUnmatched] = useState<string[]>([]);
  const [showUnmatched, setShowUnmatched] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');

  const appendLog = (msg: string) => setLog(prev => [...prev, msg]);

  const handleImport = async () => {
    const listId = extractPlaylistId(url.trim());
    if (!listId) {
      setErrorMsg('有効な YouTube プレイリスト URL または ID を入力してください');
      return;
    }

    setPhase('fetching');
    setLog([]);
    setSongs([]);
    setUnmatched([]);
    setShowUnmatched(false);
    setErrorMsg('');

    try {
      appendLog('YouTube プレイリストを取得中...');
      const videoIds = await fetchPlaylistVideos(listId, (loaded) => {
        appendLog(`ページ取得中: ${loaded} 件取得済み`);
      });
      appendLog(`${videoIds.length} 件の動画を取得しました`);

      setPhase('matching');
      const matched: Song[] = [];
      const unmatchedIds: string[] = [];
      const batchSize = 5;

      for (let i = 0; i < videoIds.length; i += batchSize) {
        const batch = videoIds.slice(i, i + batchSize);
        const results = await Promise.all(batch.map(id => fetchVocadbByYouTubeId(id)));
        results.forEach((song, idx) => {
          if (song) matched.push(song);
          else unmatchedIds.push(batch[idx]);
        });
        appendLog(`${Math.min(i + batchSize, videoIds.length)} / ${videoIds.length} 照合済み → ${matched.length} 件マッチ`);
      }

      setSongs(matched);
      setUnmatched(unmatchedIds);
      setPhase('done');
      appendLog(`完了: ${matched.length} 件の曲が見つかりました（未マッチ: ${unmatchedIds.length} 件）`);
    } catch (e) {
      setPhase('error');
      setErrorMsg(e instanceof Error ? e.message : '不明なエラー');
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.7)' }}
      onClick={e => e.target === e.currentTarget && onClose()}
    >
      <div
        className="rounded-2xl p-6 w-full max-w-lg flex flex-col gap-4"
        style={{ background: 'var(--color-bg-card)', border: '1px solid var(--color-border)' }}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold">YouTube プレイリストをインポート</h2>
          <button onClick={onClose} className="p-1 rounded-lg hover:opacity-70" style={{ color: 'var(--color-text-muted)' }}>
            <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* URL 入力 */}
        <div className="flex gap-2">
          <input
            type="text"
            value={url}
            onChange={e => setUrl(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && phase === 'idle' && handleImport()}
            placeholder="https://youtube.com/playlist?list=PL..."
            className="search-input text-sm flex-1"
            style={{ paddingLeft: '0.75rem' }}
            disabled={phase === 'fetching' || phase === 'matching'}
          />
          <button
            className="btn-primary text-sm px-4"
            onClick={handleImport}
            disabled={phase === 'fetching' || phase === 'matching' || !url.trim()}
          >
            取得
          </button>
        </div>

        {/* エラー */}
        {errorMsg && (
          <p className="text-sm" style={{ color: 'var(--color-error, #f87171)' }}>{errorMsg}</p>
        )}

        {/* ログ */}
        {log.length > 0 && (
          <div
            className="rounded-xl p-3 text-xs font-mono overflow-y-auto max-h-40 space-y-0.5"
            style={{ background: 'var(--color-bg)', color: 'var(--color-text-muted)' }}
          >
            {log.map((l, i) => <div key={i}>{l}</div>)}
          </div>
        )}

        {/* 結果サマリー */}
        {phase === 'done' && (
          <p className="text-sm" style={{ color: 'var(--color-text-secondary)' }}>
            {songs.length} 件の曲が VocaDB でマッチしました
          </p>
        )}

        {/* 未マッチ一覧 */}
        {phase === 'done' && unmatched.length > 0 && (
          <div>
            <button
              className="text-sm flex items-center gap-1"
              style={{ color: 'var(--color-text-muted)' }}
              onClick={() => setShowUnmatched(v => !v)}
            >
              <svg className="w-3 h-3" style={{ transform: showUnmatched ? 'rotate(90deg)' : '', transition: 'transform 0.15s' }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path d="M9 18l6-6-6-6"/></svg>
              未マッチ: {unmatched.length} 件（VocaDB未登録・非公開かも）
            </button>
            {showUnmatched && (
              <div
                className="rounded-xl p-2 mt-1 text-xs font-mono overflow-y-auto max-h-32 space-y-0.5"
                style={{ background: 'var(--color-bg)', color: 'var(--color-text-muted)' }}
              >
                {unmatched.map(id => (
                  <div key={id}>
                    <a
                      href={`https://www.youtube.com/watch?v=${id}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{ color: 'var(--color-accent)' }}
                    >
                      https://www.youtube.com/watch?v={id}
                    </a>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ボタン */}
        <div className="flex gap-3 justify-end">
          <button className="btn-secondary text-sm" onClick={onClose}>
            キャンセル
          </button>
          {phase === 'done' && songs.length > 0 && (
            <button
              className="btn-primary text-sm"
              onClick={() => { onImport(songs); onClose(); }}
            >
              {songs.length} 曲をインポート
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
