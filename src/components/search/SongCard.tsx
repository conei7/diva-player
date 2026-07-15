import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Song } from '../../types/vocadb';
import { Link } from 'react-router-dom';
import { usePlayerStore, getPlayablePV } from '../../stores/playerStore';
import { useUiStore } from '../../stores/uiStore';
import { usePlaylistStore, WATCH_LATER_ID } from '../../stores/playlistStore';
import { useSelectionStore } from '../../stores/selectionStore';
import { formatSongRelativeDate } from '../../utils/relativeDate';
import { formatJapaneseViews } from '../../utils/formatViews';

interface SongCardProps {
  song: Song;
  index: number;
  onPlay?: (song: Song) => void;
  onAddToQueue?: (song: Song) => void;
  onSelect?: (song: Song) => void;
  recommendationReason?: string;
  onVisible?: () => void;
  onExposureClick?: () => void;
}

/**
 * SongCard - 検索結果の曲カード
 * サムネイル、曲名、アーティスト、PVサービスバッジ、再生ボタンを表示。
 */
export default function SongCard({ song, index, onPlay, onAddToQueue, onSelect, recommendationReason, onVisible, onExposureClick }: SongCardProps) {
  const { currentSong, isPlaying, setQueue, hiddenMode } = usePlayerStore();
  const { openSaveToPlaylist } = useUiStore();
  const toggleSong = usePlaylistStore(s => s.toggleSongInPlaylist);
  const isSongIn  = usePlaylistStore(s => s.isSongInPlaylist);
  const isCurrentSong = currentSong?.id === song.id;
  const playablePV = getPlayablePV(song);
  const hasPlayablePV = !!playablePV;
  const isWatchLater = isSongIn(WATCH_LATER_ID, song.id);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ top: number; right: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuPortalRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const visibilityReportedRef = useRef(false);

  // 複数選択ストア
  const isSelectionMode = useSelectionStore(s => s.isSelectionMode);
  const selectedSongIds = useSelectionStore(s => s.selectedSongIds);
  const isSelected      = selectedSongIds.has(song.id);
  const toggleSelection = useSelectionStore(s => s.toggleSong);
  const enterSelectionMode = useSelectionStore(s => s.enterSelectionMode);

  useEffect(() => {
    visibilityReportedRef.current = false;
  }, [song.id]);

  useEffect(() => {
    if (!onVisible || !cardRef.current || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(entries => {
      if (!visibilityReportedRef.current && entries[0]?.isIntersecting && (entries[0].intersectionRatio ?? 0) >= 0.35) {
        visibilityReportedRef.current = true;
        onVisible();
      }
    }, { threshold: [0.35] });
    observer.observe(cardRef.current);
    return () => observer.disconnect();
  }, [onVisible]);

  // メニュー外クリックで閉じる
  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node) && !menuPortalRef.current?.contains(e.target as Node)) {
        setMenuOpen(false);
        setMenuPos(null);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [menuOpen]);

  useEffect(() => {
    if (!menuOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setMenuOpen(false);
        setMenuPos(null);
        btnRef.current?.focus();
      }
    };
    const closeOnViewportChange = () => {
      setMenuOpen(false);
      setMenuPos(null);
    };
    document.addEventListener('keydown', handleKeyDown);
    window.addEventListener('resize', closeOnViewportChange);
    window.addEventListener('scroll', closeOnViewportChange, true);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('resize', closeOnViewportChange);
      window.removeEventListener('scroll', closeOnViewportChange, true);
    };
  }, [menuOpen]);

  // 利用可能なPVサービスのバッジ
  const pvServices = song.pvs?.reduce((acc, pv) => {
    if (!pv.disabled && (pv.service === 'Youtube' || pv.service === 'NicoNicoDouga')) {
      acc.add(pv.service);
    }
    return acc;
  }, new Set<string>()) ?? new Set();

  const ytPVs = song.pvs?.filter(pv => !pv.disabled && pv.service === 'Youtube') ?? [];
  const isYTUnofficialOnly = ytPVs.length > 0 && ytPVs.every(pv => pv.pvType !== 'Original');

  const nicoPVs = song.pvs?.filter(pv => !pv.disabled && pv.service === 'NicoNicoDouga') ?? [];
  const isNicoUnofficialOnly = nicoPVs.length > 0 && nicoPVs.every(pv => pv.pvType !== 'Original');

  // アーティスト名の抽出
  const producers = song.artists?.filter(a => a.categories?.includes('Producer')) || [];
  const producerName = producers.map(a => a.name || a.artist?.name).filter(Boolean).join(', ');
  const vocalists = song.artists?.filter(a => a.categories === 'Vocalist') || [];
  const vocalistName = vocalists.map(a => a.name || a.artist?.name).filter(Boolean).join(', ');
  const relativeDate = formatSongRelativeDate(song);

  // 再生時間フォーマット
  const formatDuration = (seconds: number): string => {
    if (!seconds) return '--:--';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  const handlePlay = useCallback((e?: React.MouseEvent) => {
    if (e) {
      e.stopPropagation();
      e.preventDefault();
    }
    // 選択モード中は再生をブロック
    if (isSelectionMode) return;

    onExposureClick?.();
    
    if (onPlay) {
      onPlay(song);
    } else {
      setQueue([song], 0);
    }
    onSelect?.(song);
  }, [isSelectionMode, onPlay, song, setQueue, onSelect, onExposureClick]);

  // カード全体でのクリックハンドラ
  const handleCardClick = useCallback((e: React.MouseEvent) => {
    if (isSelectionMode) {
      e.stopPropagation();
      e.preventDefault();
      toggleSelection(song.id);
    } else {
      handlePlay(e);
    }
  }, [isSelectionMode, toggleSelection, song.id, handlePlay]);

  const handleSongLinkClick = useCallback((e: React.MouseEvent<HTMLAnchorElement>) => {
    if (isSelectionMode) {
      e.preventDefault();
      e.stopPropagation();
      toggleSelection(song.id);
      return;
    }
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
      e.stopPropagation();
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    handlePlay(e);
  }, [handlePlay, isSelectionMode, song.id, toggleSelection]);

  const handleSongLinkAuxClick = useCallback((e: React.MouseEvent<HTMLAnchorElement>) => {
    if (isSelectionMode) {
      e.preventDefault();
    }
    e.stopPropagation();
  }, [isSelectionMode]);

  // 長押しで選択モード突入
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handlePointerDown = useCallback(() => {
    if (isSelectionMode) return;
    longPressTimer.current = setTimeout(() => {
      enterSelectionMode();
      toggleSelection(song.id);
    }, 500);
  }, [isSelectionMode, enterSelectionMode, toggleSelection, song.id]);
  const handlePointerUp = useCallback(() => {
    if (longPressTimer.current) clearTimeout(longPressTimer.current);
  }, []);
  const handlePointerLeave = useCallback(() => {
    if (longPressTimer.current) clearTimeout(longPressTimer.current);
  }, []);

  const handleWatchLater = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    toggleSong(WATCH_LATER_ID, song);
  }, [toggleSong, song]);

  const handleSaveToPlaylist = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setMenuOpen(false);
    setMenuPos(null);
    openSaveToPlaylist(song);
  }, [openSaveToPlaylist, song]);

  const handleAddToQueueFromMenu = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setMenuOpen(false);
    setMenuPos(null);
    onAddToQueue?.(song);
  }, [onAddToQueue, song]);

  const handleShare = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setMenuOpen(false);
    setMenuPos(null);
    const url = `https://vocadb.net/S/${song.id}`;
    navigator.clipboard.writeText(url).catch(() => {});
  }, [song.id]);

  const handleMenuToggle = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (menuOpen) {
      setMenuOpen(false);
      setMenuPos(null);
      return;
    }
    const rect = btnRef.current?.getBoundingClientRect();
    if (!rect) return;
    const menuHeight = 190;
    const fitsBelow = rect.bottom + 4 + menuHeight <= window.innerHeight;
    setMenuPos({
      top: Math.max(8, fitsBelow ? rect.bottom + 4 : rect.top - menuHeight - 4),
      right: window.innerWidth - rect.right,
    });
    setMenuOpen(true);
  }, [menuOpen]);

  return (
    <div
      ref={cardRef}
      className="song-card rounded-xl overflow-hidden group relative"
      style={{
        background: isSelected
          ? 'color-mix(in srgb, #1a73e8 15%, var(--color-bg-card))'
          : isCurrentSong ? 'var(--color-bg-card-hover)' : 'var(--color-bg-card)',
        border: isSelected
          ? '2px solid #1a73e8'
          : isCurrentSong ? '1px solid rgba(6, 214, 160, 0.3)' : '1px solid transparent',
        animationDelay: `${index * 50}ms`,
        cursor: isSelectionMode ? 'pointer' : undefined,
        userSelect: isSelectionMode ? 'none' : undefined,
      }}
      onClick={handleCardClick}
    >
      {/* サムネイル — クリックで再生（選択モード時は選択トグル） */}
      <Link
        to={`/watch?v=${song.id}`}
        className="block relative aspect-video overflow-hidden cursor-pointer"
        style={{ background: 'var(--color-surface)' }}
        onClick={handleSongLinkClick}
        onAuxClick={handleSongLinkAuxClick}
        onPointerDown={handlePointerDown}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerLeave}
        title={isSelectionMode ? (isSelected ? '選択解除' : '選択') : hasPlayablePV ? 'クリックして再生' : '再生可能なPVがありません'}
        aria-label={`${song.name}を再生`}
      >
        {!hiddenMode && song.thumbUrl ? (
          <img
            src={song.thumbUrl}
            alt={song.name}
            className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-105"
            loading="lazy"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center" style={hiddenMode ? { background: 'var(--color-bg-secondary)' } : {}}>
            {!hiddenMode && (
              <svg className="w-12 h-12" style={{ color: 'var(--color-text-muted)' }} viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/>
              </svg>
            )}
          </div>
        )}

        {/* 選択モード: チェックボックスオーバーレイ */}
        {isSelectionMode && (
          <div
            className="absolute inset-0 flex items-end justify-end p-2 pointer-events-none z-10"
            style={{
              background: isSelected ? 'rgba(0,0,0,0.1)' : 'rgba(0,0,0,0.3)',
              transition: 'background 0.15s',
            }}
          >
            <div
              className="w-6 h-6 rounded flex items-center justify-center transition-all shadow-md"
              style={{
                background: isSelected ? '#1a73e8' : 'rgba(255,255,255,0.7)',
                border: isSelected ? 'none' : '2px solid rgba(255,255,255,0.9)',
              }}
            >
              {isSelected && (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="white">
                  <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
                </svg>
              )}
            </div>
          </div>
        )}

        {/* 再生オーバーレイ (選択モード中は非表示) */}
        {!isSelectionMode && (
        <div
          className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity duration-200 flex items-center justify-center"
          onClick={(e) => { e.stopPropagation(); handlePlay(); }}
        >
          {hasPlayablePV && (
            <div
              className="w-12 h-12 rounded-full flex items-center justify-center transition-transform duration-200 group-hover:scale-110"
              style={{ background: 'var(--gradient-primary)' }}
            >
              {isCurrentSong && isPlaying ? (
                <svg width="20" height="20" viewBox="0 0 24 24" fill="white">
                  <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>
                </svg>
              ) : (
                <svg width="20" height="20" viewBox="0 0 24 24" fill="white" className="ml-0.5">
                  <path d="M8 5v14l11-7z"/>
                </svg>
              )}
            </div>
          )}
        </div>
        )}

        {/* 再生中インジケーター */}
        {isCurrentSong && isPlaying && (
          <div className="absolute bottom-2 left-2 px-1.5 py-0.5 rounded text-[10px] font-bold"
               style={{ background: 'rgba(29,185,84,0.85)', color: '#fff' }}>
            ▶ 再生中
          </div>
        )}

        {/* 再生時間 */}
        <div className="absolute bottom-2 right-2 px-1.5 py-0.5 rounded text-[11px] font-medium"
             style={{ background: 'rgba(0,0,0,0.7)', color: 'var(--color-text-primary)' }}>
          {formatDuration(song.lengthSeconds)}
        </div>
      </Link>

      {/* 曲情報 */}
      <div className="p-3">
        {/* タイトル行 + ⋮メニュー */}
        <div className="flex items-start gap-1">
          <div className="flex-1 min-w-0">
            <Link
              to={`/watch?v=${song.id}`}
              className="block text-sm font-semibold truncate"
              style={{ color: 'var(--color-text-primary)' }}
              onClick={handleSongLinkClick}
              onAuxClick={handleSongLinkAuxClick}
            >
              {song.name}
            </Link>
            
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
            {recommendationReason && (
              <p className="text-[10px] mt-1 truncate" style={{ color: 'var(--color-accent-cyan)' }} title={recommendationReason}>
                {recommendationReason}
              </p>
            )}
          </div>

          {/* ⋮ メニューボタン (選択モード中は非表示) */}
          {!isSelectionMode && (
          <div className="relative flex-shrink-0" ref={menuRef}>
            <button
              ref={btnRef}
              type="button"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              aria-label={`${song.name} のメニュー`}
              className="opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity p-1 rounded-md hover:bg-white/10"
              style={{ color: 'var(--color-text-muted)' }}
              onClick={handleMenuToggle}
              title="メニュー"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/>
              </svg>
            </button>

            {menuOpen && menuPos && createPortal(
              <div
                ref={menuPortalRef}
                role="menu"
                className="fixed z-[200] rounded-xl overflow-hidden shadow-2xl min-w-[180px]"
                style={{ top: menuPos.top, right: menuPos.right, background: 'var(--color-bg-card)', border: '1px solid var(--color-border)' }}
              >
                {/* 後で聴く */}
                <button
                  className="w-full flex items-center gap-3 px-4 py-2.5 text-sm hover:bg-white/5 transition-colors text-left"
                  style={{ color: isWatchLater ? 'var(--color-accent-cyan)' : 'var(--color-text-primary)' }}
                  onClick={(e) => { e.stopPropagation(); handleWatchLater(e); setMenuOpen(false); setMenuPos(null); }}
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill={isWatchLater ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" className="flex-shrink-0">
                    <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
                  </svg>
                  {isWatchLater ? '後で聴くから削除' : '後で聴く'}
                </button>

                {/* 再生リストに保存 */}
                <button
                  className="w-full flex items-center gap-3 px-4 py-2.5 text-sm hover:bg-white/5 transition-colors text-left"
                  style={{ color: 'var(--color-text-primary)' }}
                  onClick={handleSaveToPlaylist}
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="flex-shrink-0">
                    <path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z"/>
                    <polyline points="17 21 17 13 7 13 7 21"/>
                    <polyline points="7 3 7 8 15 8"/>
                  </svg>
                  再生リストに保存
                </button>

                {/* キューに追加 */}
                {onAddToQueue && hasPlayablePV && (
                  <button
                    className="w-full flex items-center gap-3 px-4 py-2.5 text-sm hover:bg-white/5 transition-colors text-left"
                    style={{ color: 'var(--color-text-primary)' }}
                    onClick={handleAddToQueueFromMenu}
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="flex-shrink-0">
                      <path d="M3 18h13v-2H3v2zm0-5h10v-2H3v2zm0-7v2h13V6H3zm18 9.59L17.42 12 21 8.41 19.59 7l-5 5 5 5L21 15.59z"/>
                    </svg>
                    キューに追加
                  </button>
                )}

                <div className="border-t" style={{ borderColor: 'var(--color-border)' }} />

                {/* 共有 */}
                <button
                  className="w-full flex items-center gap-3 px-4 py-2.5 text-sm hover:bg-white/5 transition-colors text-left"
                  style={{ color: 'var(--color-text-primary)' }}
                  onClick={handleShare}
                  title="VocaDB URLをコピー"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="flex-shrink-0">
                    <circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/>
                    <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>
                  </svg>
                  共有
                </button>
              </div>,
              document.body,
            )}
          </div>
          )}
        </div>

        {/* 下部バッジ列 */}
        <div className="flex items-center flex-wrap gap-2 mt-2">
          {/* PVサービスバッジ / 再生数 */}
          {(pvServices.has('Youtube') || (song.youtubeViews || 0) > 0) && (
            <span className="text-[10px] font-bold px-1.5 py-0.5 rounded flex items-center gap-1"
                  style={{ 
                    background: isYTUnofficialOnly ? 'rgba(100, 30, 30, 0.3)' : 'rgba(239, 68, 68, 0.12)', 
                    color: isYTUnofficialOnly ? '#b91c1c' : '#ef4444',
                    opacity: isYTUnofficialOnly ? 0.8 : 1
                  }}
                  title="YouTube 再生回数">
              <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
                <path d="M21.582 6.186a2.665 2.665 0 0 0-1.876-1.884C17.95 3.84 12 3.84 12 3.84s-5.95 0-7.706.462A2.665 2.665 0 0 0 2.418 6.186C2 7.952 2 12 2 12s0 4.048.418 5.814a2.665 2.665 0 0 0 1.876 1.884C6.05 20.16 12 20.16 12 20.16s5.95 0 7.706-.462a2.665 2.665 0 0 0 1.876-1.884C22 16.048 22 12 22 12s0-4.048-.418-5.814zM9.75 15.02v-6.04L15.05 12l-5.3 3.02z"/>
              </svg>
              {song.youtubeViews && song.youtubeViews > 0
                ? formatJapaneseViews(song.youtubeViews)
                : (isYTUnofficialOnly ? '非公式YT' : 'YT')}
            </span>
          )}
          {(pvServices.has('NicoNicoDouga') || (song.nicoViews || 0) > 0) && (
            <span className="text-[10px] font-bold px-1.5 py-0.5 rounded flex items-center gap-1"
                  style={{ 
                    background: isNicoUnofficialOnly ? 'rgba(30, 30, 100, 0.3)' : 'rgba(59, 130, 246, 0.12)', 
                    color: isNicoUnofficialOnly ? '#1e40af' : '#3b82f6',
                    opacity: isNicoUnofficialOnly ? 0.8 : 1
                  }}
                  title="ニコニコ動画 再生回数">
              📺
              {song.nicoViews && song.nicoViews > 0
                ? formatJapaneseViews(song.nicoViews)
                : (isNicoUnofficialOnly ? '非公式ニコ' : 'ニコ')}
            </span>
          )}



          {relativeDate && (
            <span className="text-[10px]" style={{ color: 'var(--color-text-muted)' }}>
              {relativeDate}
            </span>
          )}

          <div className="flex-1" />

          {/* 曲タイプ (Remixなど) */}
          {song.songType !== 'Original' && song.songType !== 'Unspecified' && (
            <span className="text-[10px] px-1.5 py-0.5 rounded font-medium leading-none"
                  style={{ background: 'rgba(139, 92, 246, 0.12)', color: 'var(--color-accent-purple)' }}>
              {song.songType}
            </span>
          )}

          {/* 詳細ボタン (削除 - カード全体クリックで選択) */}
        </div>
      </div>
    </div>
  );
}
