import type { Playlist } from '../../types/vocadb';
import PlaylistCover from './PlaylistCover';
import PlaylistPopoverMenu from './PlaylistPopoverMenu';
import { SmartPlaylistRuleSummary } from './SmartPlaylistBuilder';

export interface SmartPlaylistRefreshStatus {
  state: 'loading' | 'success' | 'empty' | 'error';
  refreshedAt?: number;
  matchedCount?: number;
  loadedCount?: number;
}

interface PlaylistHeroProps {
  playlist: Playlist;
  durationText: string;
  filteredSongCount: number;
  isFiltered: boolean;
  smartRefreshStatus?: SmartPlaylistRefreshStatus;
  onPlay: () => void;
  onShuffle: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onEditSmartRule: () => void;
  onRefreshSmart: () => void;
  onRefreshYouTube: () => void;
  onRefreshNico: () => void;
  onUnlinkYouTube: () => void;
  onUnlinkNico: () => void;
  onOpenYouTubeImport: () => void;
  onOpenNicoImport: () => void;
  onExport: () => void;
  onShare: () => void;
}

function SyncPanel({
  service,
  status,
  sourceUrl,
  lastSuccessfulAt,
  unmatchedCount,
  sourceDescription,
  onRefresh,
}: {
  service: 'YouTube' | 'ニコニコ';
  status?: 'never' | 'success' | 'partial' | 'error';
  sourceUrl: string;
  lastSuccessfulAt?: number;
  unmatchedCount?: number;
  sourceDescription: string;
  onRefresh: () => void;
}) {
  const youtube = service === 'YouTube';
  const accentClasses = youtube
    ? 'border-red-300/15 bg-red-300/[0.06] text-red-100/80'
    : 'border-cyan-300/15 bg-cyan-300/[0.06] text-cyan-100/80';
  const actionClasses = youtube
    ? 'border-red-200/20 text-red-100 hover:bg-red-200/10'
    : 'border-cyan-200/20 text-cyan-100 hover:bg-cyan-200/10';

  return (
    <div className={`flex flex-wrap items-center gap-x-3 gap-y-2 rounded-2xl border p-3 text-xs ${accentClasses}`}>
      <span className="flex items-center gap-2 font-semibold">
        <span className={`h-2 w-2 rounded-full ${status === 'error' ? 'bg-red-400' : 'bg-emerald-300'}`} />
        {service}自動同期
      </span>
      <span className="text-neutral-300">
        {status === 'error'
          ? '前回の同期に失敗しました'
          : status === 'partial'
            ? `未マッチ ${unmatchedCount ?? 0}件`
            : sourceDescription}
      </span>
      {lastSuccessfulAt && (
        <span className="text-neutral-500">最終同期 {new Date(lastSuccessfulAt).toLocaleString('ja-JP')}</span>
      )}
      <div className="ml-auto flex items-center gap-2">
        <a href={sourceUrl} target="_blank" rel="noopener noreferrer" className="underline decoration-white/30 underline-offset-2 hover:text-white">
          元ページ
        </a>
        <button type="button" onClick={onRefresh} className={`rounded-lg border px-2.5 py-1.5 transition-colors ${actionClasses}`}>
          今すぐ同期
        </button>
      </div>
    </div>
  );
}

export default function PlaylistHero({
  playlist,
  durationText,
  filteredSongCount,
  isFiltered,
  smartRefreshStatus,
  onPlay,
  onShuffle,
  onEdit,
  onDelete,
  onEditSmartRule,
  onRefreshSmart,
  onRefreshYouTube,
  onRefreshNico,
  onUnlinkYouTube,
  onUnlinkNico,
  onOpenYouTubeImport,
  onOpenNicoImport,
  onExport,
  onShare,
}: PlaylistHeroProps) {
  const isYouTubeLinked = playlist.youtubeSync?.enabled === true;
  const isNicoLinked = playlist.nicoSync?.enabled === true;
  const isExternalLinked = isYouTubeLinked || isNicoLinked;
  const backdropUrl = playlist.coverArtUrl || playlist.songs.find(song => song.thumbUrl)?.thumbUrl;
  const kindLabel = playlist.smartRule
    ? 'スマートプレイリスト'
    : playlist.isPinned
      ? 'ピン留めコレクション'
      : isExternalLinked
        ? '外部同期プレイリスト'
        : 'プレイリスト';

  return (
    <section className="relative flex-shrink-0 overflow-hidden rounded-[1.75rem] border border-white/[0.1] bg-neutral-950 shadow-2xl shadow-black/20">
      {backdropUrl && (
        <div
          className="absolute inset-0 scale-110 bg-cover bg-center opacity-30 blur-2xl"
          style={{ backgroundImage: `url(${JSON.stringify(backdropUrl)})` }}
          aria-hidden="true"
        />
      )}
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_18%_15%,rgba(6,214,160,0.18),transparent_42%),linear-gradient(110deg,rgba(8,10,14,0.7),rgba(8,10,14,0.94)_58%,rgba(8,10,14,0.98))]" aria-hidden="true" />

      <div className="relative p-4 sm:p-5 lg:p-6">
        <div className="flex flex-col gap-5 sm:flex-row sm:items-end">
          <div className="mx-auto aspect-square w-36 flex-shrink-0 overflow-hidden rounded-[1.5rem] bg-black/30 shadow-2xl shadow-black/40 ring-1 ring-white/15 sm:mx-0 sm:w-40 lg:w-48">
            <PlaylistCover playlist={playlist} />
          </div>
          <div className="min-w-0 flex-1 text-center sm:text-left">
            <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-emerald-200/70">{kindLabel}</p>
            <h1 className="mt-2 break-words text-3xl font-black leading-[1.05] tracking-[-0.03em] text-white sm:text-4xl lg:text-5xl">
              {playlist.name}
            </h1>
            {playlist.description && (
              <p className="mx-auto mt-3 line-clamp-2 max-w-3xl text-sm leading-6 text-neutral-300 sm:mx-0">{playlist.description}</p>
            )}
            <div className="mt-3 flex flex-wrap items-center justify-center gap-2 text-xs text-neutral-400 sm:justify-start">
              <span className="rounded-full border border-white/10 bg-black/20 px-2.5 py-1 font-semibold text-white">{playlist.songs.length}曲</span>
              {playlist.songs.length > 0 && <span className="rounded-full border border-white/10 bg-black/20 px-2.5 py-1">{durationText}</span>}
              {isFiltered && <span className="rounded-full border border-cyan-300/20 bg-cyan-300/10 px-2.5 py-1 text-cyan-100">表示中 {filteredSongCount}曲</span>}
              {playlist.youtubeSync && <span className="rounded-full border border-red-300/15 bg-red-300/10 px-2.5 py-1 text-red-100">YouTube同期</span>}
              {playlist.nicoSync && <span className="rounded-full border border-cyan-300/15 bg-cyan-300/10 px-2.5 py-1 text-cyan-100">ニコニコ同期</span>}
            </div>

            <div className="mt-5 flex flex-wrap items-center justify-center gap-2 sm:justify-start">
              {playlist.songs.length > 0 && (
                <>
                  <button type="button" onClick={onPlay} className="flex min-h-11 items-center gap-2 rounded-full bg-white px-5 text-sm font-bold text-black shadow-lg shadow-black/20 transition-transform hover:scale-[1.02] hover:bg-neutral-200 active:scale-[0.98]">
                    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z" /></svg>
                    再生
                  </button>
                  <button type="button" onClick={onShuffle} className="flex min-h-11 items-center gap-2 rounded-full border border-white/15 bg-black/25 px-4 text-sm font-medium text-neutral-100 backdrop-blur-sm transition-colors hover:bg-white/10">
                    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5" /></svg>
                    シャッフル
                  </button>
                </>
              )}
              {playlist.smartRule && (
                <button type="button" onClick={onRefreshSmart} disabled={smartRefreshStatus?.state === 'loading'} className="min-h-11 rounded-full border border-white/15 bg-black/25 px-4 text-sm font-medium text-neutral-100 backdrop-blur-sm transition-colors hover:bg-white/10 disabled:cursor-wait disabled:opacity-60">
                  {smartRefreshStatus?.state === 'loading' ? '更新中…' : '条件を再更新'}
                </button>
              )}
              {!playlist.isPinned && !isExternalLinked && (
                <button type="button" onClick={onEdit} className="flex min-h-11 items-center gap-2 rounded-full border border-white/15 bg-black/25 px-4 text-sm text-neutral-200 backdrop-blur-sm transition-colors hover:bg-white/10 hover:text-white">
                  <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" /><path d="M18.5 2.5a2.1 2.1 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" /></svg>
                  編集
                </button>
              )}
              <PlaylistPopoverMenu
                trigger={
                  <button type="button" className="flex h-11 w-11 items-center justify-center rounded-full border border-white/15 bg-black/25 text-neutral-200 backdrop-blur-sm transition-colors hover:bg-white/10 hover:text-white" title="その他の操作" aria-label="その他の操作">
                    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="12" cy="5" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="12" cy="19" r="2" /></svg>
                  </button>
                }
              >
                <button className="context-menu-item" onClick={onOpenYouTubeImport}>
                  <span className="flex h-5 w-5 items-center justify-center rounded-md bg-red-500/15 text-[10px] font-black text-red-300">YT</span>
                  <span>YouTubeからインポート</span>
                </button>
                <button className="context-menu-item" onClick={onOpenNicoImport}>
                  <span className="flex h-5 w-5 items-center justify-center rounded-md bg-cyan-500/15 text-[10px] font-black text-cyan-300">N</span>
                  <span>ニコニコからインポート</span>
                </button>
                <button className="context-menu-item" onClick={onExport}>
                  <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="m7 10 5 5 5-5M12 15V3" /></svg>
                  <span>JSONエクスポート</span>
                </button>
                <button className="context-menu-item" onClick={onShare}>
                  <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" /><circle cx="18" cy="19" r="3" /><path d="m8.6 13.5 6.8 4M15.4 6.5l-6.8 4" /></svg>
                  <span>共有リンクをコピー</span>
                </button>
                {isYouTubeLinked && <button className="context-menu-item" onClick={onUnlinkYouTube}><span className="h-4 w-4 text-center">×</span><span>YouTube同期を解除</span></button>}
                {isNicoLinked && <button className="context-menu-item" onClick={onUnlinkNico}><span className="h-4 w-4 text-center">×</span><span>ニコニコ同期を解除</span></button>}
                {!playlist.isPinned && !isExternalLinked && (
                  <button className="context-menu-item text-red-300" onClick={onDelete}>
                    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4h8v2" /></svg>
                    <span>プレイリストを削除</span>
                  </button>
                )}
              </PlaylistPopoverMenu>
            </div>
          </div>
        </div>

        {playlist.smartRule && (
          <div className="mt-5 rounded-2xl border border-violet-300/15 bg-black/20 p-3.5 backdrop-blur-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-violet-200/70">自動更新条件</p>
                <p className="mt-1 text-xs text-neutral-400">
                  {smartRefreshStatus?.state === 'loading' && '条件を再計算中…'}
                  {smartRefreshStatus?.state === 'success' && `条件一致 ${smartRefreshStatus.matchedCount ?? playlist.songs.length}曲・最終更新 ${new Date(smartRefreshStatus.refreshedAt ?? Date.now()).toLocaleTimeString('ja-JP')}`}
                  {smartRefreshStatus?.state === 'empty' && '条件に一致する曲はありません'}
                  {smartRefreshStatus?.state === 'error' && '更新に失敗しました。手動で再試行してください'}
                  {!smartRefreshStatus && 'プレイリストを開いたときに自動更新します'}
                </p>
              </div>
              <button type="button" className="min-h-10 rounded-xl border border-violet-200/20 bg-violet-200/10 px-3 text-xs font-medium text-violet-100 transition-colors hover:bg-violet-200/20" onClick={onEditSmartRule}>条件を編集</button>
            </div>
            <div className="mt-3"><SmartPlaylistRuleSummary rule={playlist.smartRule} /></div>
          </div>
        )}

        {playlist.youtubeSync && (
          <div className="mt-4">
            <SyncPanel
              service="YouTube"
              status={playlist.youtubeSync.lastStatus}
              sourceUrl={playlist.youtubeSync.sourceUrl}
              lastSuccessfulAt={playlist.youtubeSync.lastSuccessfulAt}
              unmatchedCount={playlist.youtubeSync.lastUnmatchedCount}
              sourceDescription="YouTubeの順序をミラー表示中"
              onRefresh={onRefreshYouTube}
            />
          </div>
        )}
        {playlist.nicoSync && (
          <div className="mt-4">
            <SyncPanel
              service="ニコニコ"
              status={playlist.nicoSync.lastStatus}
              sourceUrl={playlist.nicoSync.sourceUrl}
              lastSuccessfulAt={playlist.nicoSync.lastSuccessfulAt}
              unmatchedCount={playlist.nicoSync.lastUnmatchedCount}
              sourceDescription={`${playlist.nicoSync.sourceKind === 'mylist' ? 'マイリスト' : 'シリーズ'}の順序をミラー表示中`}
              onRefresh={onRefreshNico}
            />
          </div>
        )}
      </div>
    </section>
  );
}
