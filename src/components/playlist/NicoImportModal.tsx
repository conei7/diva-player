import { useState } from 'react';
import type { Song } from '../../types/vocadb';
import { useTranslateSourceText } from '../../i18n';
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
  const t = useTranslateSourceText();
  const [url, setUrl] = useState('');
  const [mode, setMode] = useState<'import' | 'link'>('import');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<NicoPlaylistSongsResponse | null>(null);
  const [error, setError] = useState('');
  const [showUnmatched, setShowUnmatched] = useState(false);

  const load = async () => {
    const source = extractNicoPlaylistSource(url);
    if (!source) {
      setError(t('ニコニコのマイリストまたはシリーズURLを入力してください'));
      return;
    }
    setLoading(true);
    setResult(null);
    setError('');
    try {
      setResult(await fetchNicoPlaylistSongs(source, { refresh: true }));
    } catch (reason) {
      setError(reason instanceof Error ? t(reason.message) : t('取得に失敗しました'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70" onClick={event => event.target === event.currentTarget && onClose()}>
      <div className="flex w-full max-w-lg flex-col gap-4 rounded-2xl border border-white/10 bg-[var(--color-bg-card)] p-6">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-bold">{t('ニコニコから取り込む')}</h2>
            <p className="mt-1 text-xs text-neutral-500">{t('公開マイリスト／シリーズに対応')}</p>
          </div>
          <button type="button" onClick={onClose} className="text-xl text-neutral-500 hover:text-white" aria-label={t('閉じる')}>×</button>
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
            {loading ? t('取得中…') : t('取得')}
          </button>
        </div>
        <div className="flex gap-1 rounded-xl border border-white/10 p-1 text-xs">
          <button type="button" className={`flex-1 rounded-lg px-3 py-2 ${mode === 'import' ? 'bg-white/10 text-white' : 'text-neutral-500'}`} onClick={() => setMode('import')} disabled={loading}>{t('一度だけ追加')}</button>
          <button type="button" className={`flex-1 rounded-lg px-3 py-2 ${mode === 'link' ? 'bg-white/10 text-white' : 'text-neutral-500'}`} onClick={() => setMode('link')} disabled={loading}>{t('自動同期としてリンク')}</button>
        </div>
        {error && <p className="text-sm text-red-400">{error}</p>}
        {result && (
          <div className="rounded-xl border border-white/10 bg-black/10 p-4">
            <p className="font-semibold text-white">{result.title}</p>
            <p className="mt-1 text-sm text-neutral-400">{t('{videos}本中 {songs}曲を照合', { videos: result.videoCount, songs: result.matchedCount })}</p>
            {(result.stale || result.truncated) && <p className="mt-2 text-xs text-amber-300">{result.stale ? t('保存済みデータを表示中') : t('件数上限まで取得しました')}</p>}
            {result.unmatchedVideoIds.length > 0 && (
              <div className="mt-3">
                <button type="button" className="text-xs text-neutral-400 hover:text-white" onClick={() => setShowUnmatched(value => !value)}>
                  {t('未マッチ {count}件', { count: result.unmatchedVideoIds.length })} {showUnmatched ? '▲' : '▼'}
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
          <button type="button" className="btn-secondary text-sm" onClick={onClose}>{t('キャンセル')}</button>
          {result && (result.songs.length > 0 || mode === 'link') && (
            <button type="button" className="btn-primary text-sm" onClick={() => { if (mode === 'link') onLink(result); else onImport(result.songs); onClose(); }}>
              {mode === 'link' ? t('同期プレイリストを作成') : t('{count}曲を追加', { count: result.songs.length })}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
