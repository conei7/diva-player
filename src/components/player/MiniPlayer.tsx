import { useNavigate } from 'react-router-dom';
import { usePlayerStore } from '../../stores/playerStore';
import PlayerEmbed from '../player/PlayerEmbed';

/**
 * MiniPlayer - フローティングミニプレイヤー (PiP風)
 *
 * WatchPage 以外で再生中の場合、画面右下にポップアップ表示。
 * YouTube の「ミニプレイヤー」と同じ挙動:
 * - 小さな動画プレイヤー + コントロール
 * - クリックで WatchPage に戻る
 * - 閉じるボタンで非表示
 */
export default function MiniPlayer() {
  const navigate = useNavigate();
  const {
    currentSong, isPlaying,
    pause, resume, next, previous,
  } = usePlayerStore();

  if (!currentSong) return null;

  const producerName = (() => {
    const producer = currentSong.artists?.find(a => a.categories?.includes('Producer'));
    if (producer) return producer.name || producer.artist?.name || '';
    const str = currentSong.artistString;
    if (str.includes(' feat.')) return str.split(' feat.')[0];
    return str;
  })();

  return (
    <div
      className="fixed z-50 animate-slide-up"
      style={{
        bottom: '16px',
        right: '16px',
        width: '400px',
        maxWidth: 'calc(100vw - 32px)',
        borderRadius: '12px',
        overflow: 'hidden',
        boxShadow: '0 8px 32px rgba(0,0,0,0.6), 0 0 20px rgba(0,0,0,0.3)',
        background: 'var(--color-bg-secondary)',
        border: '1px solid var(--color-border)',
      }}
    >
      {/* プレイヤー部分 */}
      <div
        className="relative w-full cursor-pointer"
        style={{ aspectRatio: '16/9', background: '#000' }}
        onClick={() => navigate(`/watch?v=${currentSong.id}`)}
      >
        <PlayerEmbed />
      </div>

      {/* コントロール部分 */}
      <div className="flex items-center gap-2 px-3 py-2">
        {/* 曲情報 */}
        <div
          className="flex-1 min-w-0 cursor-pointer"
          onClick={() => navigate(`/watch?v=${currentSong.id}`)}
        >
          <p
            className="text-sm font-medium truncate"
            style={{ color: 'var(--color-text-primary)' }}
          >
            {currentSong.name}
          </p>
          <p className="text-xs truncate" style={{ color: 'var(--color-text-muted)' }}>
            {producerName}
          </p>
        </div>

        {/* コントロールボタン */}
        <div className="flex items-center gap-0.5 flex-shrink-0">
          {/* 前の曲 */}
          <button
            className="btn-ghost p-1.5 rounded-full"
            onClick={previous}
            title="前の曲"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
              <path d="M6 6h2v12H6zm3.5 6 8.5 6V6z" />
            </svg>
          </button>

          {/* 再生/一時停止 */}
          <button
            className="rounded-full flex items-center justify-center"
            style={{
              width: 32,
              height: 32,
              background: 'var(--gradient-primary)',
              boxShadow: isPlaying ? '0 0 10px rgba(6,214,160,0.3)' : 'none',
            }}
            onClick={() => isPlaying ? pause() : resume()}
            title={isPlaying ? '一時停止' : '再生'}
          >
            {isPlaying ? (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="white">
                <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" />
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="white" style={{ marginLeft: 2 }}>
                <path d="M8 5v14l11-7z" />
              </svg>
            )}
          </button>

          {/* 次の曲 */}
          <button
            className="btn-ghost p-1.5 rounded-full"
            onClick={next}
            title="次の曲"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
              <path d="m6 18 8.5-6L6 6v12zM16 6v12h2V6h-2z" />
            </svg>
          </button>

          {/* WatchPageに戻る */}
          <button
            className="btn-ghost p-1.5 rounded-full"
            onClick={() => navigate(`/watch?v=${currentSong.id}`)}
            title="全画面で表示"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
              <path d="M19 19H5V5h7V3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2v-7h-2v7zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}
