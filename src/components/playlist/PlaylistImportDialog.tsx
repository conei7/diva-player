import { useAsyncAction } from '../../hooks/useAsyncAction';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Playlist } from '../../types/vocadb';
import { useTranslateSourceText } from '../../i18n';
import { displayPlaylistName } from '../../utils/displayNames';
import { isPlaylistEditable } from '../../utils/playlistPermissions';
import Button from '../ui/Button';
import { Chip } from '../ui/Chip';
import Dialog from '../ui/Dialog';
import { InfoTip } from '../ui/InfoTip';
import SongThumbnail from '../ui/SongThumbnail';
import Switch from '../ui/Switch';
import { ChevronDownIcon, SpinnerIcon } from '../ui/icons';
import { cx } from '../ui/overlay';
import { PLAYLIST_FIELD_CLASS, PLAYLIST_FIELD_LABEL_CLASS } from './playlistDisplay';
import {
  detectPlaylistImportService,
  usePlaylistImportLoader,
  type PlaylistImportResult,
  type PlaylistImportService,
} from './usePlaylistImport';

export interface PlaylistImportSaveOptions {
  /** Keep the new playlist in sync with the source (always a new playlist). */
  sync: boolean;
  /** Existing playlist to add the songs to, or null for a new playlist. */
  targetId: string | null;
}

interface PlaylistImportDialogProps {
  /** Opened from a playlist's ⋮ (「このプレイリストにインポート」): that playlist is the default target. */
  initialTargetId: string | null;
  playlists: Playlist[];
  onClose: () => void;
  /** 「ファイルから」: the JSON import. */
  onImportFile: () => void;
  /** Saves the result; throwing keeps the dialog open with 「保存できませんでした」. */
  onSave: (result: PlaylistImportResult, options: PlaylistImportSaveOptions) => void | Promise<void>;
}

const NEW_TARGET = '';

/** プレイリストをインポート / 曲を追加: one dialog for YouTube and Niconico playlist URLs. */
export default function PlaylistImportDialog({ initialTargetId, playlists, onClose, onImportFile, onSave }: PlaylistImportDialogProps) {
  const { busy: saving, run: runSave } = useAsyncAction();
  const t = useTranslateSourceText();
  const { phase, load, reset } = usePlaylistImportLoader();
  // The dialog is for pasting a URL: focus goes there (not to the YouTube chip before it).
  const urlRef = useRef<HTMLInputElement>(null);
  const [url, setUrl] = useState('');
  const [service, setService] = useState<PlaylistImportService>('youtube');
  const [sync, setSync] = useState(false);
  const [targetId, setTargetId] = useState(initialTargetId ?? NEW_TARGET);
  const [saveFailed, setSaveFailed] = useState(false);

  const targets = useMemo(() => playlists.filter(playlist => isPlaylistEditable(playlist)), [playlists]);
  const result = phase.state === 'done' ? phase.result : null;
  // A YouTube result loaded for the other mode has to be loaded again (different source).
  const needsReload = result !== null && result.service === 'youtube' && result.loadedForSync !== sync;

  useEffect(() => {
    if (needsReload) void load(url, 'youtube', sync);
  }, [load, needsReload, sync, url]);

  const changeUrl = (value: string) => {
    setUrl(value);
    setSaveFailed(false);
    reset();
    const detected = detectPlaylistImportService(value);
    if (detected) setService(detected);
  };
  const changeService = (next: PlaylistImportService) => {
    if (next === service) return;
    setService(next);
    setSaveFailed(false);
    reset();
  };
  const startLoad = () => {
    if (!url.trim() || phase.state === 'loading') return;
    setSaveFailed(false);
    void load(url, service, sync);
  };

  const effectiveTarget = sync ? NEW_TARGET : targetId;
  const canSave = result !== null && !needsReload && (sync || result.songs.length > 0);
  const save = () => { void runSave(async () => {
    if (!result || !canSave) return;
    try {
      await onSave(result, { sync, targetId: effectiveTarget || null });
    } catch {
      setSaveFailed(true);
    }
  }); };

  const loading = phase.state === 'loading';
  const progress = phase.state === 'loading' ? phase.progress : undefined;
  const watchBase = result?.service === 'niconico' ? 'https://www.nicovideo.jp/watch/' : 'https://www.youtube.com/watch?v=';

  let errorText: string | null = null;
  if (phase.state === 'error') {
    errorText = phase.reason === 'invalid-nico-url'
      ? t('マイリストかシリーズのURLを入力してください')
      : phase.reason === 'invalid-url' ? t('プレイリストのURLを入力してください') : t('読み込めませんでした');
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={initialTargetId ? t('曲を追加') : t('プレイリストをインポート')}
      size="md"
      initialFocusRef={urlRef}
      footerStart={<Button variant="text" onClick={onImportFile}>{t('ファイルから')}</Button>}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose}>{t('キャンセル')}</Button>
          <Button variant="primary" loading={saving} disabled={!canSave || saving} onClick={save} data-testid="playlist-import-save">{t('保存')}</Button>
        </>
      )}
    >
      <div className="flex flex-col gap-4 pt-1">
        <div className="flex gap-3" role="group" aria-label={t('サービス')}>
          <Chip selected={service === 'youtube'} onClick={() => changeService('youtube')}>YouTube</Chip>
          <Chip selected={service === 'niconico'} onClick={() => changeService('niconico')}>{t('ニコニコ')}</Chip>
        </div>

        <div>
          <label htmlFor="playlist-import-url" className={PLAYLIST_FIELD_LABEL_CLASS}>URL</label>
          <div className="flex items-center gap-2">
            <input
              ref={urlRef}
              id="playlist-import-url"
              className={cx(PLAYLIST_FIELD_CLASS, 'min-w-0 flex-1')}
              value={url}
              onChange={event => changeUrl(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  startLoad();
                }
              }}
              placeholder={t('YouTube・ニコニコのプレイリストURL')}
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
            />
            <Button variant="primary" size="sm" className="shrink-0" disabled={!url.trim() || loading} onClick={startLoad}>
              {t('読み込む')}
            </Button>
          </div>
          {service === 'niconico' && (
            <p className="m-0 mt-1.5 text-xs leading-[18px] text-yt-text-secondary">{t('公開マイリスト・シリーズのみ')}</p>
          )}
          {errorText && (
            <div className="mt-1.5 flex items-center gap-2">
              <p role="alert" className="m-0 text-xs leading-[18px] text-yt-danger">{errorText}</p>
              {phase.state === 'error' && phase.reason === 'failed' && (
                <Button variant="text" size="sm" onClick={startLoad}>{t('再試行')}</Button>
              )}
            </div>
          )}
        </div>

        {loading && (
          <div role="status" className="flex flex-col gap-2">
            <p className="m-0 flex items-center gap-2 text-sm leading-5 text-yt-text-secondary tabular-nums">
              <SpinnerIcon size={20} />
              {progress
                ? t('確認中… {done} / {total}本', { done: progress.done, total: progress.total })
                : t('読み込み中…')}
            </p>
            {progress && progress.total > 0 && (
              <div className="h-0.5 overflow-hidden rounded-full bg-yt-tonal">
                <div className="h-full bg-brand transition-[width] duration-150" style={{ width: `${(progress.done / progress.total) * 100}%` }} />
              </div>
            )}
          </div>
        )}

        {result && !needsReload && (
          <>
            <section aria-live="polite" className="flex items-start gap-3">
              {result.songs[0] && <SongThumbnail song={result.songs[0]} className="w-24" radius="sm" showDuration={false} />}
              <div className="min-w-0 flex-1">
                <p className="m-0 line-clamp-2 text-sm font-bold leading-5 text-yt-text [overflow-wrap:anywhere]">
                  {result.title || (result.service === 'youtube' ? t('YouTubeのプレイリスト') : t('ニコニコのプレイリスト'))}
                </p>
                <p className="m-0 mt-0.5 text-sm leading-5 text-yt-text-secondary tabular-nums">
                  {t('{videos}本中 {songs}曲が見つかりました', { videos: result.videoCount, songs: result.songs.length })}
                </p>
                {result.stale && <p className="m-0 text-xs leading-[18px] text-yt-text-secondary">{t('前回取得した内容です')}</p>}
                {result.truncated && <p className="m-0 text-xs leading-[18px] text-yt-text-secondary">{t('上限まで取得しました')}</p>}
              </div>
            </section>

            {result.unmatchedVideoIds.length > 0 && (
              <details className="group/details -mt-2">
                <summary className="flex min-h-10 cursor-pointer list-none items-center gap-1 text-sm text-yt-text [&::-webkit-details-marker]:hidden">
                  <ChevronDownIcon size={20} className="-rotate-90 transition-transform duration-150 group-open/details:rotate-0" />
                  {t('見つからなかった動画（{count}本）', { count: result.unmatchedVideoIds.length })}
                </summary>
                <ul className="m-0 max-h-40 list-none overflow-y-auto p-0 pl-6">
                  {result.unmatchedVideoIds.map(id => (
                    <li key={id}>
                      <a
                        href={`${watchBase}${encodeURIComponent(id)}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="block truncate py-1 text-sm leading-5 text-yt-link hover:underline"
                      >
                        {id}
                      </a>
                    </li>
                  ))}
                </ul>
              </details>
            )}

            <div className="flex flex-col gap-3 border-t border-yt-divider pt-4">
              <div className="flex items-center gap-1">
                <Switch checked={sync} onChange={setSync} label={t('元のリストと同期')} className="min-h-10 flex-1" />
                <InfoTip label={t('同期について')} placement="bottom-end">
                  {t('1日1回、元のリストに合わせて更新します')}
                </InfoTip>
              </div>
              <label className="block">
                <span className={PLAYLIST_FIELD_LABEL_CLASS}>{t('保存先')}</span>
                <select
                  className={PLAYLIST_FIELD_CLASS}
                  value={effectiveTarget}
                  disabled={sync}
                  onChange={event => setTargetId(event.target.value)}
                >
                  <option value={NEW_TARGET}>{t('新しいプレイリスト')}</option>
                  {!sync && targets.map(playlist => (
                    <option key={playlist.id} value={playlist.id}>{displayPlaylistName(playlist, t)}</option>
                  ))}
                </select>
              </label>
              {result.songs.length === 0 && (
                <p className="m-0 text-sm leading-5 text-yt-text-secondary">
                  {sync ? t('今は0曲です（次の同期で再確認）') : t('保存できる曲がありません')}
                </p>
              )}
              {saveFailed && <p role="alert" className="m-0 text-sm leading-5 text-yt-danger">{t('保存できませんでした')}</p>}
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}
