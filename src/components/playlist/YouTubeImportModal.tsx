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
  videoCount: number;
  videos: InvidiousVideo[];
  // Invidiousはページネーションがなく全動画を一度に返す
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

async function fetchPlaylistVideos(listId: string): Promise<string[]> {
  // Invidious APIは全動画を一度に返す（ページネーション不要）
  const res = await fetch(`${INVIDIOUS_PROXY}/api/v1/playlists/${encodeURIComponent(listId)}`);
  if (!res.ok) {
    throw new Error(`YouTubeプレイリストの取得に失敗しました (HTTP ${res.status})`);
  }
  const data: InvidiousPlaylist = await res.json();
  return (data.videos ?? []).map(v => v.videoId).filter(Boolean);
}

async function fetchVocadbByYouTubeId(videoId: string): Promise<Song | null> {
  const res = await fetch(
    `${VOCADB_BASE}/songs/byPv?pvService=Youtube&pvId=${encodeURIComponent(videoId)}&fields=PVs,Artists`
  );
  if (res.status === 404) return null;
  if (!res.ok) return null;
  const data = await res.json();
  if (!data || !data.id) return null;
  if (data.songType !== 'Original') return null;
  return data as Song;
}

export default function YouTubeImportModal({ onClose, onImport }: Props) {
  const [url, setUrl] = useState('');
  const [phase, setPhase] = useState<'idle' | 'fetching' | 'matching' | 'done' | 'error'>('idle');
  const [log, setLog] = useState<string[]>([]);
  const [songs, setSongs] = useState<Song[]>([]);
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
    setErrorMsg('');

    try {
      appendLog('YouTube プレイリストを取得中...');
      const videoIds = await fetchPlaylistVideos(listId);
      appendLog(`${videoIds.length} 件の動画を取得しました`);

      setPhase('matching');
      const matched: Song[] = [];
      const batchSize = 5;

      for (let i = 0; i < videoIds.length; i += batchSize) {
        const batch = videoIds.slice(i, i + batchSize);
        const results = await Promise.all(batch.map(id => fetchVocadbByYouTubeId(id)));
        for (const song of results) {
          if (song) matched.push(song);
        }
        appendLog(`${Math.min(i + batchSize, videoIds.length)} / ${videoIds.length} 照合済み → ${matched.length} 件マッチ`);
      }

      setSongs(matched);
      setPhase('done');
      appendLog(`完了: ${matched.length} 件の Original 曲が見つかりました`);
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
            {songs.length} 件の Original 曲が VocaDB でマッチしました
          </p>
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
