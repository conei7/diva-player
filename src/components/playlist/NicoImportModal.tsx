import { useEffect, useRef, useState } from 'react';
import type { Song } from '../../types/vocadb';
import { useTranslateSourceText } from '../../i18n';
import { extractNicoPlaylistSource, fetchNicoPlaylistSongs, type NicoPlaylistSongsResponse } from '../../api/nicoPlaylist';
import PlaylistDialog from './PlaylistDialog';

interface Props {
  onClose: () => void;
  onImport: (songs: Song[], title: string, intoExisting: boolean) => void;
  onLink: (response: NicoPlaylistSongsResponse) => void;
  targetName?: string;
}

export default function NicoImportModal({ onClose, onImport, onLink, targetName }: Props) {
  const t = useTranslateSourceText();
  const [url, setUrl] = useState('');
  const [mode, setMode] = useState<'import' | 'link'>('import');
  const [intoExisting, setIntoExisting] = useState(false);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<NicoPlaylistSongsResponse | null>(null);
  const [error, setError] = useState('');
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);

  const changeUrl = (value: string) => {
    request.current?.abort();
    setUrl(value); setResult(null); setError(''); setLoading(false);
  };
  const load = async () => {
    const source = extractNicoPlaylistSource(url);
    if (!source) { setError(t('ニコニコのマイリストまたはシリーズURLを入力してください')); return; }
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true); setResult(null); setError('');
    try {
      const response = await fetchNicoPlaylistSongs(source, { refresh: true, signal: controller.signal });
      if (!controller.signal.aborted) setResult(response);
    } catch (reason) {
      if (!controller.signal.aborted) setError(reason instanceof Error ? t(reason.message) : t('取得に失敗しました'));
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  };
  const save = () => {
    if (!result || loading) return;
    try {
      if (mode === 'link') onLink(result);
      else onImport(result.songs, result.title, intoExisting);
      onClose();
    } catch {
      setError(t('保存できませんでした。空き容量などを確認して、もう一度お試しください。'));
    }
  };
  return (
    <PlaylistDialog titleId="nico-import-title" onClose={onClose}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-medium text-cyan-300">{t('外部プレイリストを読み込む')}</p>
          <h2 id="nico-import-title" className="mt-1 text-xl font-bold">{t('ニコニコから取り込む')}</h2>
          <p className="mt-2 text-sm leading-6 text-neutral-400">{t('公開マイリスト／シリーズのURLを貼り付けて、DIVAで再生できる曲を保存します。')}</p>
        </div>
        <button type="button" onClick={onClose} className="h-11 w-11 shrink-0 rounded-xl text-xl text-neutral-400 hover:bg-white/10" aria-label={t('閉じる')}>×</button>
      </div>
      <ol className="my-5 flex gap-2 text-xs text-neutral-400" aria-label={t('読み込みの手順')}>
        {[t('1 URLを入力'), t('2 曲を確認'), t('3 保存方法を選ぶ')].map((step, index) => <li key={step} className={`flex-1 rounded-lg px-2 py-2 text-center ${index === (result ? 2 : loading ? 1 : 0) ? 'bg-cyan-300/10 text-cyan-200' : 'bg-white/5'}`}>{step}</li>)}
      </ol>
      <label className="block text-sm font-medium" htmlFor="nico-source-url">{t('マイリスト・シリーズのURL')}</label>
      <div className="mt-2 flex gap-2">
        <input id="nico-source-url" className="playlist-field min-w-0 flex-1 text-sm" value={url}
          onChange={event => changeUrl(event.target.value)} onKeyDown={event => event.key === 'Enter' && !loading && void load()}
          placeholder="https://www.nicovideo.jp/mylist/..." autoFocus aria-describedby="nico-url-help" />
        <button type="button" className="btn-primary min-h-11 px-4 text-sm" onClick={() => void load()} disabled={loading || !url.trim()}>{loading ? t('取得中…') : t('取得')}</button>
      </div>
      <p id="nico-url-help" className="mt-2 break-words text-xs leading-5 text-neutral-500">{t('例: nicovideo.jp/mylist/12345 または nicovideo.jp/series/12345。個別の動画URL・非公開リストは使えません。')}</p>
      {error && <p role="alert" className="mt-3 rounded-xl bg-red-400/10 p-3 text-sm text-red-300">{error}</p>}
      {result && <>
        <section className="mt-5 rounded-xl border border-white/10 bg-black/15 p-4" aria-live="polite">
          <h3 className="break-words font-semibold">{result.title}</h3>
          <p className="mt-1 text-sm text-cyan-200">{t('{videos}本中 {songs}曲を照合', { videos: result.videoCount, songs: result.matchedCount })}</p>
          <p className="mt-2 text-xs leading-5 text-neutral-400">{t('DIVAに登録されている曲だけを取り込みます。動画をそのまま全件保存する機能ではありません。')}</p>
          {result.stale && <p className="mt-2 text-xs text-amber-300">{t('保存済みデータを表示中')}</p>}
          {result.truncated && <p className="mt-2 text-xs text-amber-300">{t('件数上限まで取得しました')}</p>}
          {result.songs.length > 0 && <ul className="mt-3 max-h-36 space-y-2 overflow-y-auto text-sm text-neutral-300">{result.songs.slice(0, 5).map(song => <li key={song.id} className="truncate">{song.name}</li>)}</ul>}
          {result.unmatchedVideoIds.length > 0 && <details className="mt-3 text-xs">
            <summary className="cursor-pointer py-2 text-amber-200">{t('未マッチ {count}件', { count: result.unmatchedVideoIds.length })}</summary>
            <p className="mb-2 leading-5 text-neutral-400">{t('未登録の動画は保存対象外です。元の動画はこちらから確認できます。')}</p>
            <div className="max-h-28 space-y-2 overflow-y-auto">{result.unmatchedVideoIds.map(id => <a key={id} className="block text-cyan-300 hover:underline" href={`https://www.nicovideo.jp/watch/${encodeURIComponent(id)}`} target="_blank" rel="noreferrer">{id}</a>)}</div>
          </details>}
        </section>
        <fieldset className="mt-5 space-y-2">
          <legend className="mb-2 text-sm font-semibold">{t('保存方法')}</legend>
          <label className={`flex cursor-pointer gap-3 rounded-xl border p-3 ${mode === 'import' ? 'border-cyan-300/40 bg-cyan-300/5' : 'border-white/10'}`}>
            <input type="radio" name="nico-save-mode" checked={mode === 'import'} onChange={() => setMode('import')} className="mt-1 accent-cyan-400" />
            <span><span className="block text-sm font-medium">{t('一度だけ追加')}</span><span className="mt-1 block text-xs leading-5 text-neutral-400">{t('今の曲を保存します。あとから曲の追加・削除・並べ替えができます。')}</span></span>
          </label>
          <label className={`flex cursor-pointer gap-3 rounded-xl border p-3 ${mode === 'link' ? 'border-cyan-300/40 bg-cyan-300/5' : 'border-white/10'}`}>
            <input type="radio" name="nico-save-mode" checked={mode === 'link'} onChange={() => setMode('link')} className="mt-1 accent-cyan-400" />
            <span><span className="block text-sm font-medium">{t('自動同期としてリンク')}</span><span className="mt-1 block text-xs leading-5 text-neutral-400">{t('新しいリストを作り、DIVAを開いている間に1日ごとに元リストへ合わせます。曲の追加・削除・順序も元リストに従います。')}</span></span>
          </label>
        </fieldset>
        {mode === 'import' && targetName && <label className="mt-3 block text-xs text-neutral-400">{t('保存先')}<select className="playlist-field mt-1 w-full text-sm" value={intoExisting ? 'existing' : 'new'} onChange={event => setIntoExisting(event.target.value === 'existing')}><option value="new">{t('新しいプレイリストを作成')}</option><option value="existing">{targetName}</option></select></label>}
        {result.songs.length === 0 && <p className="mt-3 text-sm leading-6 text-amber-200">{mode === 'link' ? t('現在保存できる曲は0曲です。同期リストは空で作成され、次の同期で再確認します。') : t('保存できる曲がありません。URLを変更するか、自動同期を選んでください。')}</p>}
      </>}
      <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <button type="button" className="btn-secondary min-h-11 text-sm" onClick={onClose}>{t('キャンセル')}</button>
        {result && <button type="button" className="btn-primary min-h-11 text-sm" disabled={loading || (mode === 'import' && result.songs.length === 0)} onClick={save}>{mode === 'link' ? t('同期プレイリストを作成') : t('{count}曲を保存', { count: result.songs.length })}</button>}
      </div>
    </PlaylistDialog>
  );
}
