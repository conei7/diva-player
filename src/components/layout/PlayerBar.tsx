import { usePlayerStore } from '../../stores/playerStore';
import { useProgressStore } from '../../stores/progressStore';
import { useRatingStore } from '../../stores/ratingStore';
import StarRating from '../player/StarRating';
import SleepTimer from '../player/SleepTimer';

/**
 * PlayerBar - 画面下部固定のプレイヤーコントロール (YouTube Music スタイル)
 *
 * 左: サムネイル + 曲情報 + 星評価
 * 中: 前/再生・一時停止/次 + シークバー + 時間表示
 * 右: 音量 + 各種アイコンボタン
 */
export default function PlayerBar() {
  const {
    currentSong, currentPV, isPlaying, volume,
    next, previous, pause, resume, setVolume, seekTo,
    hiddenMode, toggleHiddenMode,
    queue, queueDrawerOpen, toggleQueueDrawer,
    historyDrawerOpen, toggleHistoryDrawer,
    shuffleEnabled, toggleShuffle,
  } = usePlayerStore();
  const progress = useProgressStore((s) => s.progress);
  const duration = useProgressStore((s) => s.duration);
  const { getRating, setRating } = useRatingStore();

  const progressPct = duration > 0 ? Math.min(100, (progress / duration) * 100) : 0;

  const formatTime = (s: number) => {
    if (!s || isNaN(s) || !isFinite(s)) return '0:00';
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, '0')}`;
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!duration) return;
    seekTo((Number(e.target.value) / 100) * duration);
  };


  return (
    <div
      className="fixed bottom-0 left-0 right-0 z-50 glass-strong"
      style={{ height: 'var(--player-bar-height)' }}
    >
      <div className="h-full flex items-center px-3 sm:px-5 gap-2 sm:gap-3">

        {/* ─── LEFT: サムネイル + 曲情報 + 星評価 ─── */}
        <div className="flex items-center gap-3 flex-shrink-0 min-w-0" style={{ width: '240px' }}>
          <div
            className="w-12 h-12 rounded-lg overflow-hidden flex-shrink-0"
            style={{ background: 'var(--color-surface)' }}
          >
            {!hiddenMode && currentSong?.thumbUrl ? (
              <img
                src={currentSong.thumbUrl}
                alt={currentSong.name}
                className="w-full h-full object-cover"
              />
            ) : (
              <div className="w-full h-full flex items-center justify-center">
                <svg className="w-6 h-6" style={{ color: 'var(--color-text-muted)' }} viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/>
                </svg>
              </div>
            )}
          </div>
          {currentSong ? (
            <div className="min-w-0">
              <p className="text-sm font-semibold truncate" style={{ color: 'var(--color-text-primary)' }}>
                {currentSong.name}
              </p>
              <p className="text-xs truncate" style={{ color: 'var(--color-text-secondary)' }}>
                {currentSong.artistString}
              </p>
              <div className="mt-0.5">
                <StarRating
                  rating={getRating(currentSong.id)}
                  onRate={(r) => setRating(currentSong.id, r)}
                  size="sm"
                />
              </div>
            </div>
          ) : (
            <p className="text-sm" style={{ color: 'var(--color-text-muted)' }}>
              曲を選択してください
            </p>
          )}
        </div>

        {/* ─── CENTER: コントロール + シークバー ─── */}
        <div className="flex-1 flex flex-col items-center justify-center gap-1.5 min-w-0">
          {/* コントロール行 */}
          <div className="flex items-center gap-1.5">
            {/* 前の曲 */}
            <button
              className="btn-ghost p-1.5 rounded-full"
              onClick={previous}
              disabled={!currentSong}
              title="前の曲"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                <path d="M6 6h2v12H6zm3.5 6 8.5 6V6z"/>
              </svg>
            </button>

            {/* 再生 / 一時停止 */}
            <button
              className="rounded-full flex items-center justify-center transition-all duration-200"
              style={{
                width: 36,
                height: 36,
                background: currentSong ? 'var(--gradient-primary)' : 'var(--color-surface)',
                cursor: currentSong ? 'pointer' : 'default',
                boxShadow: isPlaying ? '0 0 14px rgba(6,214,160,0.4)' : 'none',
              }}
              onClick={() => isPlaying ? pause() : resume()}
              disabled={!currentSong}
              title={isPlaying ? '一時停止' : '再生'}
            >
              {isPlaying ? (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="white">
                  <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>
                </svg>
              ) : (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="white" style={{ marginLeft: 2 }}>
                  <path d="M8 5v14l11-7z"/>
                </svg>
              )}
            </button>

            {/* 次の曲 */}
            <button
              className="btn-ghost p-1.5 rounded-full"
              onClick={next}
              disabled={!currentSong}
              title="次の曲"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                <path d="m6 18 8.5-6L6 6v12zM16 6v12h2V6h-2z"/>
              </svg>
            </button>


          </div>

          {/* シークバー行 */}
          <div className="flex items-center gap-2 w-full max-w-lg">
            <span
              className="text-[11px] w-8 text-right flex-shrink-0 tabular-nums"
              style={{ color: 'var(--color-text-muted)' }}
            >
              {formatTime(progress)}
            </span>
            <input
              type="range"
              min="0"
              max="100"
              step="0.1"
              value={progressPct}
              onChange={handleSeek}
              disabled={!currentSong || !duration}
              className="flex-1 progress-slider"
              title="シーク"
            />
            <span
              className="text-[11px] w-8 flex-shrink-0 tabular-nums"
              style={{ color: 'var(--color-text-muted)' }}
            >
              {formatTime(duration)}
            </span>
          </div>
        </div>

        {/* ─── RIGHT: 音量 + アイコン群 ─── */}
        <div className="flex items-center gap-1 flex-shrink-0">
          {/* PVサービスバッジ */}
          {currentPV && (
            <span
              className="hidden lg:inline text-[10px] font-bold px-2 py-0.5 rounded-full mr-1"
              style={(() => {
                const isOriginal = currentPV.pvType === 'Original';
                if (currentPV.service === 'Youtube') {
                  return {
                    background: isOriginal ? 'rgba(239, 68, 68, 0.15)' : 'rgba(100, 30, 30, 0.3)',
                    color: isOriginal ? '#ef4444' : '#b91c1c'
                  };
                } else {
                  return {
                    background: isOriginal ? 'rgba(59, 130, 246, 0.15)' : 'rgba(30, 30, 100, 0.3)',
                    color: isOriginal ? '#3b82f6' : '#1e40af'
                  };
                }
              })()}
            >
              {currentPV.service === 'Youtube'
                ? (currentPV.pvType !== 'Original' ? '非公式YT' : 'YouTube')
                : (currentPV.pvType !== 'Original' ? '非公式ニコ' : 'ニコニコ')}
            </span>
          )}

          {/* ボリューム */}
          <div className="hidden sm:flex items-center gap-1.5 mr-1">
            <button
              className="btn-ghost p-1"
              onClick={() => setVolume(volume > 0 ? 0 : 80)}
              title="ミュート切替"
            >
              {volume === 0 ? (
                <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor" style={{ color: 'var(--color-text-muted)' }}>
                  <path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3 3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4 9.91 6.09 12 8.18V4z"/>
                </svg>
              ) : (
                <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor" style={{ color: 'var(--color-text-secondary)' }}>
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

          {/* シャッフル */}
          <button
            className="btn-ghost p-1.5 rounded-lg"
            onClick={toggleShuffle}
            title={shuffleEnabled ? 'シャッフルOFF' : 'シャッフルON'}
            style={{ color: shuffleEnabled ? 'var(--color-accent-cyan)' : 'var(--color-text-muted)' }}
          >
            <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor">
              <path d="M10.59 9.17 5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.41-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z"/>
            </svg>
          </button>

          {/* 隠しモードトグル */}
          <SleepTimer />

          <button
            className="btn-ghost p-1.5 rounded-lg"
            onClick={toggleHiddenMode}
            title={hiddenMode ? '隠しモードOFF' : '隠しモードON'}
            style={{ color: hiddenMode ? 'var(--color-accent-cyan)' : 'var(--color-text-muted)' }}
          >
            {hiddenMode ? (
              <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 7c2.76 0 5 2.24 5 5 0 .65-.13 1.26-.36 1.83l2.92 2.92c1.51-1.26 2.7-2.89 3.43-4.75-1.73-4.39-6-7.5-11-7.5-1.4 0-2.74.25-3.98.7l2.16 2.16C10.74 7.13 11.35 7 12 7zM2 4.27l2.28 2.28.46.46A11.804 11.804 0 0 0 1 12c1.73 4.39 6 7.5 11 7.5 1.55 0 3.03-.3 4.38-.84l.42.42L19.73 22 21 20.73 3.27 3 2 4.27zM7.53 9.8l1.55 1.55c-.05.21-.08.43-.08.65 0 1.66 1.34 3 3 3 .22 0 .44-.03.65-.08l1.55 1.55c-.67.33-1.41.53-2.2.53-2.76 0-5-2.24-5-5 0-.79.2-1.53.53-2.2zm4.31-.78 3.15 3.15.02-.16c0-1.66-1.34-3-3-3l-.17.01z"/>
              </svg>
            ) : (
              <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"/>
              </svg>
            )}
          </button>

          {/* 履歴ドロワー */}
          <button
            className="btn-ghost p-1.5 rounded-lg"
            onClick={toggleHistoryDrawer}
            title="視聴履歴"
            style={{ color: historyDrawerOpen ? 'var(--color-accent-cyan)' : 'var(--color-text-muted)' }}
          >
            <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor">
              <path d="M13 3a9 9 0 1 0 9 9h-2a7 7 0 1 1-7-7V3zm7 1-4 4 4-4zM11 8v5l4.28 2.54.72-1.21-3.5-2.08V8H11z"/>
            </svg>
          </button>

          {/* キュードロワー (モバイルのみ表示。デスクトップは右サイドバーで常時表示) */}
          <button
            className="lg:hidden btn-ghost p-1.5 rounded-lg relative"
            onClick={toggleQueueDrawer}
            title="再生キュー"
            style={{ color: queueDrawerOpen ? 'var(--color-accent-purple)' : 'var(--color-text-muted)' }}
          >
            <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor">
              <path d="M3 18h13v-2H3v2zm0-5h10v-2H3v2zm0-7v2h13V6H3zm18 9.59L17.42 12 21 8.41 19.59 7l-5 5 5 5L21 15.59z"/>
            </svg>
            {queue.length > 0 && (
              <span
                className="absolute -top-0.5 -right-0.5 text-[9px] font-bold w-4 h-4 rounded-full flex items-center justify-center leading-none"
                style={{ background: 'var(--color-accent-purple)', color: '#fff' }}
              >
                {queue.length > 99 ? '99+' : queue.length}
              </span>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
