import { useState } from 'react';
import type { Song } from '../../types/vocadb';
import {
  extractNicoPlaylistSource,
  fetchNicoPlaylistSongs,
  type NicoPlaylistSongsResponse,
} from '../../api/nicoPlaylist';

interface Props {
  onClose: () => void;
  onImport: (songs: Song[]) => void;
  onLink: (response: NicoPlaylistSongsResponse) => void;
}

export default function NicoImportModal({ onClose, onImport, onLink }: Props) {
  const [url, setUrl] = useState('');
  const [mode, setMode] = useState<'import' | 'link'>('import');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<NicoPlaylistSongsResponse | null>(null);
  const [error, setError] = useState('');
  const [showUnmatched, setShowUnmatched] = useState(false);

  const load = async () => {
    const source = extractNicoPlaylistSource(url);
    if (!source) {
      setError('ニコニコのマイリストまたはシリーズURLを入力してください');
      return;
    }
    setLoading(true);
    setResult(null);
    setError('');
    try {
      setResult(await fetchNicoPlaylistSongs(source, { refresh: true }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '取得に失敗しました');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70" onClick={event => event.target === event.currentTarget && onClose()}>
      <div className="flex w-full max-w-lg flex-col gap-4 rounded-2xl border border-white/10 bg-[var(--color-bg-card)] p-6">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-bold">ニコニコから取り込む</h2>
            <p className="mt-1 text-xs text-neutral-500">公開マイリスト／シリーズに対応</p>
          </div>
          <button type="button" onClick={onClose} className="text-xl text-neutral-500 hover:text-white" aria-label="閉じる">×</button>
        </div>
        <div className="flex gap-2">
          <input
            className="search-input min-w-0 flex-1 text-sm"
            style={{ paddingLeft: '0.75rem' }}
            value={url}
            onChange={event => setUrl(event.target.value)}
            onKeyDown={event => event.key === 'Enter' && !loading && void load()}
            placeholder="https://www.nicovideo.jp/mylist/..."
            disabled={loading}
            autoFocus
          />
          <button type="button" className="btn-primary px-4 text-sm" onClick={() => void load()} disabled={loading || !url.trim()}>
            {loading ? '取得中…' : '取得'}
          </button>
        </div>
        <div className="flex gap-1 rounded-xl border border-white/10 p-1 text-xs">
          <button type="button" className={`flex-1 rounded-lg px-3 py-2 ${mode === 'import' ? 'bg-white/10 text-white' : 'text-neutral-500'}`} onClick={() => setMode('import')} disabled={loading}>一度だけ追加</button>
          <button type="button" className={`flex-1 rounded-lg px-3 py-2 ${mode === 'link' ? 'bg-white/10 text-white' : 'text-neutral-500'}`} onClick={() => setMode('link')} disabled={loading}>自動同期としてリンク</button>
        </div>
        {error && <p className="text-sm text-red-400">{error}</p>}
        {result && (
          <div className="rounded-xl border border-white/10 bg-black/10 p-4">
            <p className="font-semibold text-white">{result.title}</p>
            <p className="mt-1 text-sm text-neutral-400">{result.videoCount}本中 {result.matchedCount}曲を照合</p>
            {(result.stale || result.truncated) && <p className="mt-2 text-xs text-amber-300">{result.stale ? '保存済みデータを表示中' : '件数上限まで取得しました'}</p>}
            {result.unmatchedVideoIds.length > 0 && (
              <div className="mt-3">
                <button type="button" className="text-xs text-neutral-400 hover:text-white" onClick={() => setShowUnmatched(value => !value)}>
                  未マッチ {result.unmatchedVideoIds.length}件 {showUnmatched ? '▲' : '▼'}
                </button>
                {showUnmatched && (
                  <div className="mt-2 max-h-28 space-y-1 overflow-y-auto text-xs">
                    {result.unmatchedVideoIds.map(id => <a key={id} className="block text-cyan-300 hover:underline" href={`https://www.nicovideo.jp/watch/${id}`} target="_blank" rel="noreferrer">{id}</a>)}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
        <div className="flex justify-end gap-3">
          <button type="button" className="btn-secondary text-sm" onClick={onClose}>キャンセル</button>
          {result && (result.songs.length > 0 || mode === 'link') && (
            <button type="button" className="btn-primary text-sm" onClick={() => { if (mode === 'link') onLink(result); else onImport(result.songs); onClose(); }}>
              {mode === 'link' ? '同期プレイリストを作成' : `${result.songs.length}曲を追加`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
