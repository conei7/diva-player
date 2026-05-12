import { usePlayerStore } from '../../stores/playerStore';
import { useRatingStore } from '../../stores/ratingStore';
import StarRating from '../player/StarRating';

/**
 * PlayerBar - 画面下部固定のプレイヤーコントロール
 * 
 * 現在再生中の曲情報、再生コントロール、プログレスバー、
 * ボリュームコントロール、埋め込みプレイヤーを統合。
 */
export default function PlayerBar() {
  const {
    currentSong, currentPV, isPlaying, volume,
    next, previous, setVolume, hiddenMode, toggleHiddenMode,
    autoQueue, toggleAutoQueue,
    queue, queueDrawerOpen, toggleQueueDrawer,
    historyDrawerOpen, toggleHistoryDrawer,
  } = usePlayerStore();
  const { getRating, setRating } = useRatingStore();


  return (
    <div
      className="fixed bottom-0 left-0 right-0 z-50 glass-strong"
      style={{ height: 'var(--player-bar-height)' }}
    >
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-full flex items-center gap-4">
        {/* サムネイル表示 */}
        <div className="relative w-16 h-16 rounded-lg overflow-hidden flex-shrink-0"
             style={{ background: 'var(--color-surface)' }}>
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

        {/* 曲情報 */}
        <div className="flex-shrink-0 w-48 min-w-0">
          {currentSong ? (
            <div className="animate-fade-in">
              <div className="flex items-center gap-1.5">
                <p className="text-sm font-semibold truncate" style={{ color: 'var(--color-text-primary)' }}>
                  {currentSong.name}
                </p>
              </div>
              <p className="text-xs truncate mt-0.5" style={{ color: 'var(--color-text-secondary)' }}>
                {currentSong.artistString}
              </p>
              <div className="mt-1">
                <StarRating
                  rating={getRating(currentSong.id)}
                  onRate={(r) => setRating(currentSong.id, r)}
                  size="md"
                />
              </div>
            </div>
          ) : (
            <p className="text-sm" style={{ color: 'var(--color-text-muted)' }}>
              曲を選択してください
            </p>
          )}
        </div>

        {/* 再生コントロール: 前へ / 次へ */}
        <div className="flex items-center gap-2 flex-shrink-0">
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
            className="btn-ghost p-2 rounded-full"
            onClick={next}
            disabled={!currentSong}
            title="次の曲"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
              <path d="m6 18 8.5-6L6 6v12zM16 6v12h2V6h-2z"/>
            </svg>
          </button>

          {/* 自動キュートグル（関連曲の連続再生） */}
          <button
            className="btn-ghost p-2 rounded-full"
            onClick={toggleAutoQueue}
            title={autoQueue ? '連続再生ON（関連曲を自動追加）' : '連続再生OFF'}
            style={{ color: autoQueue ? 'var(--color-accent-cyan)' : 'var(--color-text-muted)' }}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
              <path d="M18.6 6.62c-1.44 0-2.8.56-3.77 1.53L12 10.66 10.48 12h.01L7.8 14.39c-.64.64-1.49.99-2.4.99-1.87 0-3.39-1.51-3.39-3.38S3.53 8.62 5.4 8.62c.91 0 1.76.35 2.44 1.03l1.13 1 1.51-1.34L9.22 8.2C8.2 7.18 6.84 6.62 5.4 6.62 2.42 6.62 0 9.04 0 12s2.42 5.38 5.4 5.38c1.44 0 2.8-.56 3.77-1.53l2.83-2.5.01.01L13.52 12h-.01l2.69-2.39c.64-.64 1.49-.99 2.4-.99 1.87 0 3.39 1.51 3.39 3.38s-1.52 3.38-3.39 3.38c-.9 0-1.76-.35-2.44-1.03l-1.13-1-1.51 1.34 1.27 1.12c1.02 1.01 2.37 1.57 3.81 1.57 2.98 0 5.4-2.41 5.4-5.38s-2.42-5.38-5.4-5.38z"/>
            </svg>
          </button>
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
              {currentPV.service === 'Youtube'
                ? (currentPV.pvType !== 'Original' ? '非公式YouTube' : 'YouTube')
                : (currentPV.pvType !== 'Original' ? '非公式ニコニコ' : 'ニコニコ')}
            </span>
          </div>
        )}

        {/* 隠しモードトグルボタン */}
        <button
          className="btn-ghost p-1.5 rounded-lg flex-shrink-0"
          onClick={toggleHiddenMode}
          title={hiddenMode ? '隠しモードOFF（画像・動画を表示）' : '隠しモードON（画像・動画を非表示）'}
          style={{ color: hiddenMode ? 'var(--color-accent-cyan)' : 'var(--color-text-muted)' }}
        >
          {hiddenMode ? (
            // 目を閉じているアイコン (非表示中)
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 7c2.76 0 5 2.24 5 5 0 .65-.13 1.26-.36 1.83l2.92 2.92c1.51-1.26 2.7-2.89 3.43-4.75-1.73-4.39-6-7.5-11-7.5-1.4 0-2.74.25-3.98.7l2.16 2.16C10.74 7.13 11.35 7 12 7zM2 4.27l2.28 2.28.46.46A11.804 11.804 0 0 0 1 12c1.73 4.39 6 7.5 11 7.5 1.55 0 3.03-.3 4.38-.84l.42.42L19.73 22 21 20.73 3.27 3 2 4.27zM7.53 9.8l1.55 1.55c-.05.21-.08.43-.08.65 0 1.66 1.34 3 3 3 .22 0 .44-.03.65-.08l1.55 1.55c-.67.33-1.41.53-2.2.53-2.76 0-5-2.24-5-5 0-.79.2-1.53.53-2.2zm4.31-.78 3.15 3.15.02-.16c0-1.66-1.34-3-3-3l-.17.01z"/>
            </svg>
          ) : (
            // 目が開いているアイコン (表示中)
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"/>
            </svg>
          )}
        </button>

        {/* 履歴ドロワートグルボタン */}
        <button
          className="btn-ghost p-1.5 rounded-lg flex-shrink-0"
          onClick={toggleHistoryDrawer}
          title="視聴履歴"
          style={{ color: historyDrawerOpen ? 'var(--color-accent-cyan)' : 'var(--color-text-muted)' }}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
            <path d="M13 3a9 9 0 1 0 9 9h-2a7 7 0 1 1-7-7V3zm7 1-4 4 4-4zM11 8v5l4.28 2.54.72-1.21-3.5-2.08V8H11z"/>
          </svg>
        </button>

        {/* キュードロワートグルボタン */}
        <button
          className="btn-ghost p-1.5 rounded-lg flex-shrink-0 relative"
          onClick={toggleQueueDrawer}
          title="再生キューを表示"
          style={{ color: queueDrawerOpen ? 'var(--color-accent-purple)' : 'var(--color-text-muted)' }}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
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
  );
}
