import { useRef, useCallback } from 'react';
import { usePlayerStore } from '../../stores/playerStore';
import PlayerEmbed from '../player/PlayerEmbed';

/**
 * PlayerBar - 画面下部固定のプレイヤーコントロール
 * 
 * 現在再生中の曲情報、再生コントロール、プログレスバー、
 * ボリュームコントロール、埋め込みプレイヤーを統合。
 */
export default function PlayerBar() {
  const {
    currentSong, currentPV, isPlaying, volume, progress, duration,
    pause, resume, next, previous, setVolume, setProgress,
  } = usePlayerStore();

  const progressRef = useRef<HTMLDivElement>(null);

  // プログレスバーのクリック/ドラッグでシーク
  const handleProgressClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!progressRef.current || !duration) return;
    const rect = progressRef.current.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    setProgress(ratio * duration);
  }, [duration, setProgress]);

  // 時間フォーマット
  const formatTime = (seconds: number): string => {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  const progressPercent = duration > 0 ? (progress / duration) * 100 : 0;

  return (
    <div
      className="fixed bottom-0 left-0 right-0 z-50 glass-strong"
      style={{ height: 'var(--player-bar-height)' }}
    >
      {/* プログレスバー（バー上部） */}
      <div
        ref={progressRef}
        className="progress-track absolute top-0 left-0 right-0 -translate-y-1/2"
        onClick={handleProgressClick}
      >
        <div className="progress-fill" style={{ width: `${progressPercent}%` }} />
      </div>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-full flex items-center gap-4">
        {/* 埋め込みプレイヤー (小さいサムネイルサイズ) */}
        <div className="relative w-16 h-16 rounded-lg overflow-hidden flex-shrink-0"
             style={{ background: 'var(--color-surface)' }}>
          {currentPV ? (
            <PlayerEmbed />
          ) : (
            <div className="w-full h-full flex items-center justify-center">
              <svg className="w-6 h-6" style={{ color: 'var(--color-text-muted)' }} viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/>
              </svg>
            </div>
          )}
        </div>

        {/* 曲情報 */}
        <div className="flex-shrink-0 w-48 min-w-0">
          {currentSong ? (
            <div className="animate-fade-in">
              <div className="flex items-center gap-1.5">
                <p className="text-sm font-semibold truncate" style={{ color: 'var(--color-text-primary)' }}>
                  {currentSong.name}
                </p>
                {currentPV?.pvType === 'Other' && (
                  <span className="flex-shrink-0 text-[10px] px-1.5 py-0.5 rounded font-medium" style={{ background: 'rgba(234,179,8,0.2)', color: 'rgb(234,179,8)' }}>
                    非公式
                  </span>
                )}
              </div>
              <p className="text-xs truncate mt-0.5" style={{ color: 'var(--color-text-secondary)' }}>
                {currentSong.artistString}
              </p>
            </div>
          ) : (
            <p className="text-sm" style={{ color: 'var(--color-text-muted)' }}>
              曲を選択してください
            </p>
          )}
        </div>

        {/* 再生コントロール */}
        <div className="flex items-center gap-3 flex-shrink-0">
          <button
            className="btn-ghost p-2 rounded-full"
            onClick={previous}
            disabled={!currentSong}
            title="前の曲"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
              <path d="M6 6h2v12H6zm3.5 6 8.5 6V6z"/>
            </svg>
          </button>

          <button
            className="w-10 h-10 rounded-full flex items-center justify-center transition-all duration-200"
            style={{
              background: currentSong ? 'var(--gradient-primary)' : 'var(--color-surface)',
              cursor: currentSong ? 'pointer' : 'default',
              opacity: currentSong ? 1 : 0.5,
            }}
            onClick={() => {
              if (!currentSong) return;
              isPlaying ? pause() : resume();
            }}
            disabled={!currentSong}
            title={isPlaying ? '一時停止' : '再生'}
          >
            {isPlaying ? (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="white">
                <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>
              </svg>
            ) : (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="white">
                <path d="M8 5v14l11-7z"/>
              </svg>
            )}
          </button>

          <button
            className="btn-ghost p-2 rounded-full"
            onClick={next}
            disabled={!currentSong}
            title="次の曲"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
              <path d="m6 18 8.5-6L6 6v12zM16 6v12h2V6h-2z"/>
            </svg>
          </button>
        </div>

        {/* タイムスタンプ */}
        <div className="flex items-center gap-2 text-xs flex-shrink-0" style={{ color: 'var(--color-text-muted)' }}>
          <span className="w-10 text-right tabular-nums">{formatTime(progress)}</span>
          <span>/</span>
          <span className="w-10 tabular-nums">{formatTime(duration)}</span>
        </div>

        {/* スペーサー */}
        <div className="flex-1" />

        {/* イコライザー表示 */}
        {isPlaying && (
          <div className="flex items-end gap-0.5 h-5 mr-2">
            <span className="equalizer-bar" />
            <span className="equalizer-bar" />
            <span className="equalizer-bar" />
            <span className="equalizer-bar" />
          </div>
        )}

        {/* ボリューム */}
        <div className="flex items-center gap-2 flex-shrink-0">
          <button className="btn-ghost p-1" onClick={() => setVolume(volume > 0 ? 0 : 80)} title="ミュート">
            {volume === 0 ? (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" style={{ color: 'var(--color-text-muted)' }}>
                <path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3 3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4 9.91 6.09 12 8.18V4z"/>
              </svg>
            ) : (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" style={{ color: 'var(--color-text-secondary)' }}>
                <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/>
              </svg>
            )}
          </button>
          <input
            type="range"
            min="0"
            max="100"
            value={volume}
            onChange={(e) => setVolume(Number(e.target.value))}
            className="volume-slider w-20"
            title={`音量: ${volume}%`}
          />
        </div>

        {/* PVサービスバッジ */}
        {currentPV && (
          <div className="flex-shrink-0">
            <span
              className="text-[10px] font-bold px-2 py-0.5 rounded-full"
              style={{
                background: currentPV.service === 'Youtube'
                  ? 'rgba(239, 68, 68, 0.15)'
                  : 'rgba(59, 130, 246, 0.15)',
                color: currentPV.service === 'Youtube'
                  ? '#ef4444'
                  : '#3b82f6',
              }}
            >
              {currentPV.service === 'Youtube' ? 'YouTube' : 'ニコニコ'}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
