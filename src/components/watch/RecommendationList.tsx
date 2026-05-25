import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import type { Song } from '../../types/vocadb';
import { usePlayerStore } from '../../stores/playerStore';
import { useUiStore } from '../../stores/uiStore';
import { usePlaylistStore, WATCH_LATER_ID } from '../../stores/playlistStore';
import { useSelectionStore } from '../../stores/selectionStore';

/**
 * RecommendationList - 推薦動画リスト
 *
 * WatchPage右側パネル。サムネイル + 曲名 + P名 の縦リスト。
 * クリックで /watch?v=songId へSPA遷移（ページリロードなし）
 */
interface RecommendationListProps {
  songs: Song[];
  loading: boolean;
  hasMore: boolean;
}

/** サムネイルURLを解決 */
function getThumbUrl(song: Song): string | null {
  if (song.thumbUrl) return song.thumbUrl;
  const yt = song.pvs?.find(pv => pv.service === 'Youtube');
  if (yt) return `https://img.youtube.com/vi/${yt.pvId}/hqdefault.jpg`;
  return null;
}

/** 再生時間フォーマット */
function formatDuration(seconds: number): string {
  if (!seconds) return '';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

const formatJapaneseViews = (views?: number): string | null => {
  if (views === undefined || views <= 0) return null;
  if (views >= 100000000) {
    return (views / 100000000).toFixed(1).replace('.0', '') + '億';
  } else if (views >= 10000) {
    return (views / 10000).toFixed(1).replace('.0', '') + '万';
  } else {
    return views.toLocaleString();
  }
};

/** 個別曲アイテム（⋮メニュー付き） */
function RecItemRow({
  song,
  isActive,
  hiddenMode,
  isPlaying,
}: {
  song: Song;
  isActive: boolean;
  hiddenMode: boolean;
  isPlaying: boolean;
}) {
  const navigate = useNavigate();
  const { openSaveToPlaylist } = useUiStore();
  const toggleSongInPlaylist = usePlaylistStore(s => s.toggleSongInPlaylist);
  const isSongIn   = usePlaylistStore(s => s.isSongInPlaylist);
  const isWatchLater = isSongIn(WATCH_LATER_ID, song.id);

  const isSelectionMode = useSelectionStore(s => s.isSelectionMode);
  const selectedSongIds = useSelectionStore(s => s.selectedSongIds);
  const toggleSelection = useSelectionStore(s => s.toggleSong);
  const isSelected = selectedSongIds.has(song.id);

  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ top: number; right: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const btnRef  = useRef<HTMLButtonElement>(null);

  // メニュー外クリックで閉じる（Portal 対応: btnRef と menuRef 両方をチェック）
  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e: MouseEvent) => {
      if (btnRef.current?.contains(e.target as Node)) return;
      if (menuRef.current?.contains(e.target as Node)) return;
      setMenuOpen(false);
      setMenuPos(null);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [menuOpen]);

  const handleMenuToggle = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (menuOpen) { setMenuOpen(false); setMenuPos(null); return; }
    const rect = btnRef.current?.getBoundingClientRect();
    if (!rect) return;
    const menuHeight = 130;
    const fitsBelow = rect.bottom + 4 + menuHeight <= window.innerHeight;
    setMenuPos({
      top: fitsBelow ? rect.bottom + 4 : rect.top - menuHeight - 4,
      right: window.innerWidth - rect.right,
    });
    setMenuOpen(true);
  }, [menuOpen]);

  const handleWatchLater = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setMenuOpen(false); setMenuPos(null);
    toggleSongInPlaylist(WATCH_LATER_ID, song);
  }, [toggleSongInPlaylist, song]);

  const handleSave = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setMenuOpen(false); setMenuPos(null);
    openSaveToPlaylist(song);
  }, [openSaveToPlaylist, song]);

  const handleShare = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setMenuOpen(false); setMenuPos(null);
    navigator.clipboard.writeText(`https://vocadb.net/S/${song.id}`).catch(() => {});
  }, [song.id]);

  const thumbUrl = getThumbUrl(song);
  const duration = formatDuration(song.lengthSeconds);

  // YouTubeにOriginalがない（非公式のみ: ReprntまたはOtherのみ）
  const ytPVs = song.pvs?.filter(pv => !pv.disabled && pv.service === 'Youtube') ?? [];
  const isYTUnofficialOnly = ytPVs.length > 0 && ytPVs.every(pv => pv.pvType !== 'Original');

  // ニコニコにOriginalがない（非公式のみ）
  const nicoPVs = song.pvs?.filter(pv => !pv.disabled && pv.service === 'NicoNicoDouga') ?? [];
  const isNicoUnofficialOnly = nicoPVs.length > 0 && nicoPVs.every(pv => pv.pvType !== 'Original');

  // アーティスト名の抽出
  const producers = song.artists?.filter(a => a.categories?.includes('Producer')) || [];
  const producerName = producers.map(a => a.name || a.artist?.name).filter(Boolean).join(', ');
  const vocalists = song.artists?.filter(a => a.categories === 'Vocalist') || [];
  const vocalistName = vocalists.map(a => a.name || a.artist?.name).filter(Boolean).join(', ');

  const handleCardClick = useCallback((e: React.MouseEvent) => {
    if (isSelectionMode) {
      e.stopPropagation();
      e.preventDefault();
      toggleSelection(song.id);
    } else {
      navigate(`/watch?v=${song.id}`);
    }
  }, [isSelectionMode, toggleSelection, song.id, navigate]);

  return (
    <>
    <div
      className="rec-item animate-fade-in group relative"
      style={{
        background: isSelected
          ? 'color-mix(in srgb, #1a73e8 15%, var(--color-bg-card))'
          : isActive ? 'var(--color-surface)' : 'transparent',
        outline: isSelected ? '2px solid #1a73e8' : 'none',
        outlineOffset: '-2px',
        userSelect: isSelectionMode ? 'none' : undefined,
      }}
      onClick={handleCardClick}
    >
      {/* \u30b5\u30e0\u30cd\u30a4\u30eb */}
      <div
        className="relative w-40 flex-shrink-0 rounded-lg overflow-hidden"
        style={{ aspectRatio: '16/9', background: 'var(--color-surface)' }}
      >
        {!hiddenMode && thumbUrl ? (
          <img src={thumbUrl} alt={song.name} className="w-full h-full object-cover" loading="lazy" />
        ) : (
          <div className="w-full h-full flex items-center justify-center" style={{ background: 'var(--color-bg-secondary)' }}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" style={{ color: 'var(--color-text-muted)', opacity: 0.3 }}>
              <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z" />
            </svg>
          </div>
        )}
        {isActive && isPlaying && (
          <div className="absolute inset-0 bg-black/40 flex items-center justify-center">
            <div className="flex items-end gap-0.5 h-4">
              {[0, 1, 2, 3].map(i => (
                <span key={i} className="equalizer-bar" style={{ height: '3px', animationDelay: `${i * 0.15}s` }} />
              ))}
            </div>
          </div>
        )}
        <div className="absolute bottom-1 right-1 flex items-center gap-1 z-10">
          {duration && (
            <span
              className="px-1 py-0.5 rounded text-[10px] font-medium leading-none"
              style={{ background: 'rgba(0,0,0,0.8)', color: '#fff' }}
            >
              {duration}
            </span>
          )}
        </div>
        {/* 選択モード: チェックボックスオーバーレイ */}
        {isSelectionMode && (
          <div
            className="absolute inset-0 flex items-end justify-end p-1.5 pointer-events-none z-10"
            style={{
              background: isSelected ? 'rgba(0,0,0,0.1)' : 'rgba(0,0,0,0.3)',
              transition: 'background 0.15s',
            }}
          >
            <div
              className="w-5 h-5 rounded flex items-center justify-center transition-all shadow-md"
              style={{
                background: isSelected ? '#1a73e8' : 'rgba(255,255,255,0.7)',
                border: isSelected ? 'none' : '2px solid rgba(255,255,255,0.9)',
              }}
            >
              {isSelected && (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="white">
                  <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
                </svg>
              )}
            </div>
          </div>
        )}
      </div>

      {/* \u30c6\u30ad\u30b9\u30c8 + \u22ee\u30dc\u30bf\u30f3 */}
      <div className="flex-1 min-w-0 py-0.5 flex items-start gap-1">
        <div className="flex-1 min-w-0">
          <h4 className="line-clamp-2 text-sm font-medium leading-5"
              style={{ color: isActive ? 'var(--color-accent-cyan)' : 'var(--color-text-primary)' }}
              title={song.name}>
            {song.name}
            {song.songType !== 'Original' && song.songType !== 'Unspecified' && (
              <span
                className="ml-2 inline-block px-1.5 py-0.5 rounded text-[10px] font-medium leading-none align-middle"
                style={{ background: 'var(--color-accent-purple)', color: '#fff' }}
              >
                {song.songType}
              </span>
            )}
          </h4>
          
          {vocalistName ? (
            <p className="text-xs mt-0.5 truncate" style={{ color: 'var(--color-text-secondary)' }}>
              feat. {vocalistName}
            </p>
          ) : (
            <div className="h-0" />
          )}

          <p className="text-xs mt-0.5 truncate" style={{ color: 'var(--color-text-muted)' }}>
            {producerName || song.artistString}
          </p>

          <div className="flex items-center gap-2 mt-1 flex-wrap">
            {(song.youtubeViews || 0) > 0 && (
              <span className="text-[10px] font-bold px-1.5 py-0.5 rounded flex items-center gap-0.5"
                    style={{
                      background: isYTUnofficialOnly ? 'rgba(100, 30, 30, 0.3)' : 'rgba(239, 68, 68, 0.12)',
                      color: isYTUnofficialOnly ? '#b91c1c' : '#ef4444',
                      opacity: isYTUnofficialOnly ? 0.8 : 1
                    }}>
                <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M21.582 6.186a2.665 2.665 0 0 0-1.876-1.884C17.95 3.84 12 3.84 12 3.84s-5.95 0-7.706.462A2.665 2.665 0 0 0 2.418 6.186C2 7.952 2 12 2 12s0 4.048.418 5.814a2.665 2.665 0 0 0 1.876 1.884C6.05 20.16 12 20.16 12 20.16s5.95 0 7.706-.462a2.665 2.665 0 0 0 1.876-1.884C22 16.048 22 12 22 12s0-4.048-.418-5.814zM9.75 15.02v-6.04L15.05 12l-5.3 3.02z"/>
                </svg>
                {formatJapaneseViews(song.youtubeViews)}
              </span>
            )}
            {(song.nicoViews || 0) > 0 && (
              <span className="text-[10px] font-bold px-1.5 py-0.5 rounded flex items-center gap-0.5"
                    style={{
                      background: isNicoUnofficialOnly ? 'rgba(30, 30, 100, 0.3)' : 'rgba(59, 130, 246, 0.12)',
                      color: isNicoUnofficialOnly ? '#1e40af' : '#3b82f6',
                      opacity: isNicoUnofficialOnly ? 0.8 : 1
                    }}>
                📺 {formatJapaneseViews(song.nicoViews)}
              </span>
            )}
            {song.favoritedTimes > 0 && (
              <span className="text-[10px] flex items-center gap-0.5 font-medium" style={{ color: 'var(--color-text-muted)' }}>
                ♥ {song.favoritedTimes.toLocaleString()}
              </span>
            )}
          </div>

        </div>

        {/* ⋮ ボタン (選択モード中は非表示) */}
        {!isSelectionMode && (
        <div className="relative flex-shrink-0">
          <button
            ref={btnRef}
            className="opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded-md hover:bg-white/10"
            style={{ color: 'var(--color-text-muted)' }}
            onClick={handleMenuToggle}
            title="メニュー"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/>
            </svg>
          </button>
        </div>
        )}
      </div>
    </div>

    {/* メニュー Portal: position:fixed が transform 親の影響を受けないよう document.body に描画 */}
    {menuOpen && menuPos && createPortal(
      <div
        ref={menuRef}
        className="fixed z-[200] rounded-xl overflow-hidden shadow-2xl min-w-[180px]"
        style={{ top: menuPos.top, right: menuPos.right, background: 'var(--color-bg-card)', border: '1px solid var(--color-border)' }}
      >
        <button className="w-full flex items-center gap-3 px-4 py-2.5 text-sm hover:bg-white/5 transition-colors text-left"
                style={{ color: isWatchLater ? 'var(--color-accent-cyan)' : 'var(--color-text-primary)' }}
                onClick={handleWatchLater}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill={isWatchLater ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" className="flex-shrink-0">
            <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
          </svg>
          {isWatchLater ? '後で聴くから削除' : '後で聴く'}
        </button>
        <button className="w-full flex items-center gap-3 px-4 py-2.5 text-sm hover:bg-white/5 transition-colors text-left"
                style={{ color: 'var(--color-text-primary)' }}
                onClick={handleSave}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="flex-shrink-0">
            <path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z"/>
            <polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/>
          </svg>
          再生リストに保存
        </button>
        <div className="border-t" style={{ borderColor: 'var(--color-border)' }} />
        <button className="w-full flex items-center gap-3 px-4 py-2.5 text-sm hover:bg-white/5 transition-colors text-left"
                style={{ color: 'var(--color-text-primary)' }}
                onClick={handleShare}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="flex-shrink-0">
            <circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/>
            <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>
          </svg>
          共有
        </button>
      </div>,
      document.body
    )}
    </>
  );
}

function SkeletonItem() {  return (
    <div className="flex gap-2 p-1">
      <div className="w-40 flex-shrink-0 rounded-lg skeleton" style={{ aspectRatio: '16/9' }} />
      <div className="flex-1 space-y-1.5 py-0.5">
        <div className="h-3.5 w-full rounded skeleton" />
        <div className="h-3.5 w-3/4 rounded skeleton" />
        <div className="h-3 w-1/2 rounded skeleton" />
      </div>
    </div>
  );
}

export default function RecommendationList({
  songs,
  loading,
}: RecommendationListProps) {
  const { currentSong, isPlaying, hiddenMode } = usePlayerStore();

  if (loading && songs.length === 0) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 8 }).map((_, i) => (
          <SkeletonItem key={i} />
        ))}
      </div>
    );
  }

  if (!loading && songs.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 gap-3">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="currentColor" style={{ color: 'var(--color-text-muted)', opacity: 0.3 }}>
          <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z" />
        </svg>
        <p className="text-sm" style={{ color: 'var(--color-text-muted)' }}>曲が見つかりません</p>
      </div>
    );
  }

  return (
    <div className="space-y-1">
      {songs.map((song, index) => (
        <div key={song.id} className="animate-fade-in" style={{ animationDelay: `${(index % 20) * 30}ms` }}>
          <RecItemRow
            song={song}
            isActive={currentSong?.id === song.id}
            hiddenMode={hiddenMode}
            isPlaying={isPlaying}
          />
        </div>
      ))}

      {/* ローディング */}
      {loading && songs.length > 0 && (
        <div className="space-y-2 mt-1">
          {Array.from({ length: 3 }).map((_, i) => (
            <SkeletonItem key={`skel-${i}`} />
          ))}
        </div>
      )}
    </div>
  );
}
