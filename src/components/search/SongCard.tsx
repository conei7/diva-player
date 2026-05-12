import type { Song } from '../../types/vocadb';
import { usePlayerStore, getPlayablePV } from '../../stores/playerStore';
import { useUiStore } from '../../stores/uiStore';
interface SongCardProps {
  song: Song;
  index: number;
  onAddToQueue?: (song: Song) => void;
  onSelect?: (song: Song) => void;
}

/**
 * SongCard - 検索結果の曲カード
 * サムネイル、曲名、アーティスト、PVサービスバッジ、再生ボタンを表示。
 */
export default function SongCard({ song, index, onAddToQueue, onSelect }: SongCardProps) {
  const { currentSong, isPlaying, setQueue, hiddenMode } = usePlayerStore();
  const { openSongDetail } = useUiStore();
  const isCurrentSong = currentSong?.id === song.id;
  const playablePV = getPlayablePV(song);
  const hasPlayablePV = !!playablePV;

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
    setQueue([song], 0);
    onSelect?.(song);
  };

  const handleOpenDetail = () => {
    openSongDetail(song);
  };

  return (
    <div
      className="song-card rounded-xl overflow-hidden group"
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
          <div className="absolute bottom-2 left-2 flex items-end gap-0.5 h-4">
            <span className="equalizer-bar" />
            <span className="equalizer-bar" />
            <span className="equalizer-bar" />
          </div>
        )}

        {/* 再生時間 */}
        <div className="absolute bottom-2 right-2 px-1.5 py-0.5 rounded text-[11px] font-medium"
             style={{ background: 'rgba(0,0,0,0.7)', color: 'var(--color-text-primary)' }}>
          {formatDuration(song.lengthSeconds)}
        </div>
      </div>

      {/* 曲情報 — クリックで詳細モーダルを開く */}
      <div
        className="p-3 cursor-pointer hover:bg-white/5 transition-colors"
        onClick={handleOpenDetail}
        title="詳細を表示"
      >
        <h3 className="text-sm font-semibold truncate" style={{ color: 'var(--color-text-primary)' }}>
          {song.name}
        </h3>
        <p className="text-xs mt-1 truncate" style={{ color: 'var(--color-text-secondary)' }}>
          {song.artistString}
        </p>

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

          {/* キューに追加ボタン */}
          {onAddToQueue && hasPlayablePV && (
            <button
              className="btn-ghost p-1 opacity-0 group-hover:opacity-100 transition-opacity"
              onClick={(e) => {
                e.stopPropagation();
                onAddToQueue(song);
              }}
              title="キューに追加"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M12 5v14M5 12h14" />
              </svg>
            </button>
          )}

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