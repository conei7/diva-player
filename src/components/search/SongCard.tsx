import { useCallback, useEffect, useRef, useState } from 'react';
import type { Song } from '../../types/vocadb';
import { usePlayerStore, getPlayablePV } from '../../stores/playerStore';
import { useUiStore } from '../../stores/uiStore';
import { usePlaylistStore, WATCH_LATER_ID } from '../../stores/playlistStore';

interface SongCardProps {
  song: Song;
  index: number;
  onPlay?: (song: Song) => void;
  onAddToQueue?: (song: Song) => void;
  onSelect?: (song: Song) => void;
}

/**
 * SongCard - 検索結果の曲カード
 * サムネイル、曲名、アーティスト、PVサービスバッジ、再生ボタンを表示。
 */
export default function SongCard({ song, index, onPlay, onAddToQueue, onSelect }: SongCardProps) {
  const { currentSong, isPlaying, setQueue, hiddenMode } = usePlayerStore();
  const { openSongDetail, openSaveToPlaylist } = useUiStore();
  const toggleSong = usePlaylistStore(s => s.toggleSongInPlaylist);
  const isSongIn  = usePlaylistStore(s => s.isSongInPlaylist);
  const isCurrentSong = currentSong?.id === song.id;
  const playablePV = getPlayablePV(song);
  const hasPlayablePV = !!playablePV;
  const isWatchLater = isSongIn(WATCH_LATER_ID, song.id);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ top: number; right: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  // メニュー外クリックで閉じる
  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
        setMenuPos(null);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [menuOpen]);

  // 利用可能なPVサービスのバッジ
  const pvServices = song.pvs?.reduce((acc, pv) => {
    if (!pv.disabled && (pv.service === 'Youtube' || pv.service === 'NicoNicoDouga')) {
      acc.add(pv.service);
    }
    return acc;
  }, new Set<string>()) ?? new Set();

  // YouTubeにOriginalがない（非公式のみ: ReprntまたはOtherのみ）
  const ytPVs = song.pvs?.filter(pv => !pv.disabled && pv.service === 'Youtube') ?? [];
  const isYTUnofficialOnly = ytPVs.length > 0 && ytPVs.every(pv => pv.pvType !== 'Original');

  // ニコニコにOriginalがない（非公式のみ）
  const nicoPVs = song.pvs?.filter(pv => !pv.disabled && pv.service === 'NicoNicoDouga') ?? [];
  const isNicoUnofficialOnly = nicoPVs.length > 0 && nicoPVs.every(pv => pv.pvType !== 'Original');

  // 再生時間フォーマット
  const formatDuration = (seconds: number): string => {
    if (!seconds) return '--:--';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  const handlePlay = () => {
    if (!hasPlayablePV) return;
    if (onPlay) {
      onPlay(song); // 動的ミックスリスト生成 (SearchPage から渡される)
    } else {
      setQueue([song], 0); // フォールバック
    }
    onSelect?.(song);
  };

  const handleOpenDetail = () => {
    openSongDetail(song);
  };

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
    const menuHeight = 145;
    const fitsBelow = rect.bottom + 4 + menuHeight <= window.innerHeight;
    setMenuPos({
      top: fitsBelow ? rect.bottom + 4 : rect.top - menuHeight - 4,
      right: window.innerWidth - rect.right,
    });
    setMenuOpen(true);
  }, [menuOpen]);

  return (
    <div
      className="song-card rounded-xl overflow-hidden group relative"
      style={{
        background: isCurrentSong ? 'var(--color-bg-card-hover)' : 'var(--color-bg-card)',
        border: isCurrentSong ? '1px solid rgba(6, 214, 160, 0.3)' : '1px solid transparent',
        animationDelay: `${index * 50}ms`,
      }}
    >
      {/* サムネイル — クリックで再生 */}
      <div
        className="relative aspect-video overflow-hidden cursor-pointer"
        style={{ background: 'var(--color-surface)' }}
        onClick={handlePlay}
        title={hasPlayablePV ? 'クリックして再生' : '再生可能なPVがありません'}
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

        {/* 再生オーバーレイ */}
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
      </div>

      {/* 曲情報 */}
      <div className="p-3">
        {/* タイトル行 + ⋮メニュー */}
        <div className="flex items-start gap-1">
          <div
            className="flex-1 min-w-0 cursor-pointer"
            onClick={handleOpenDetail}
          >
            <h3 className="text-sm font-semibold truncate" style={{ color: 'var(--color-text-primary)' }}>
              {song.name}
            </h3>
            <p className="text-xs mt-1 truncate" style={{ color: 'var(--color-text-secondary)' }}>
              {song.artistString}
            </p>
          </div>

          {/* ⋮ メニューボタン */}
          <div className="relative flex-shrink-0" ref={menuRef}>
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

            {menuOpen && menuPos && (
              <div
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
              </div>
            )}
          </div>
        </div>

        {/* 下部バッジ列 */}
        <div className="flex items-center gap-2 mt-2">
          {/* PVサービスバッジ */}
          {pvServices.has('Youtube') && (
            <span className="text-[10px] font-bold px-1.5 py-0.5 rounded"
                  style={{ background: 'rgba(239, 68, 68, 0.12)', color: '#ef4444' }}>
              {isYTUnofficialOnly ? '非公式YT' : 'YT'}
            </span>
          )}
          {pvServices.has('NicoNicoDouga') && (
            <span className="text-[10px] font-bold px-1.5 py-0.5 rounded"
                  style={{ background: 'rgba(59, 130, 246, 0.12)', color: '#3b82f6' }}>
              {isNicoUnofficialOnly ? '非公式ニコ' : 'ニコ'}
            </span>
          )}

          {/* 曲タイプバッジ */}
          {song.songType !== 'Original' && (
            <span className="text-[10px] px-1.5 py-0.5 rounded"
                  style={{ background: 'rgba(139, 92, 246, 0.12)', color: 'var(--color-accent-purple)' }}>
              {song.songType}
            </span>
          )}

          <div className="flex-1" />

          {/* VocaDB お気に入り数 */}
          {song.favoritedTimes > 0 && (
            <span className="text-[10px] flex items-center gap-0.5" style={{ color: 'var(--color-text-muted)' }}
                  title="VocaDB お気に入り数">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/>
              </svg>
              {song.favoritedTimes.toLocaleString()}
            </span>
          )}

          {/* 詳細ボタン (削除 - カード全体クリックで選択) */}
        </div>
      </div>
    </div>
  );
}