import { useLocation, useNavigate } from 'react-router-dom';
import { usePlayerStore } from '../../stores/playerStore';
import PlayerEmbed from '../player/PlayerEmbed';

/**
 * GlobalPlayer - 永続化されたプレイヤーコンポーネント
 *
 * SPA遷移中（/watch <-> / 等）に iframe を絶対にアンマウントさせず、
 * 動画の再生状態を維持するための工夫。
 *
 * 1. WatchPage表示時: VideoPlayerのDOMRect (playerRect) に合わせて絶対配置し、メインプレイヤーのフリをする。
 * 2. それ以外 (HomePage等) で再生中: 右下にフローティングするMiniPlayer (PiP) として振る舞う。
 * 3. どちらでもない: 画面外または opacity: 0 で隠す。
 */
export default function GlobalPlayer() {
  const location = useLocation();
  const navigate = useNavigate();
  const {
    currentSong, playerRect, isPlaying,
    pause, resume, next, previous,
  } = usePlayerStore();

  const isWatchPage = location.pathname === '/watch';
  // WatchPage 以外で曲が選択されていればミニプレイヤーを表示
  const showMiniPlayer = !isWatchPage && !!currentSong;

  // 再生する曲がない場合は表示しない (ただしアンマウントはしたくないため opacity: 0 などで対応も可能だが、
  // 最初は何もないのでnullでOK。一度曲がセットされた後は常に存在する)
  if (!currentSong) return null;

  const producerName = (() => {
    const producer = currentSong.artists?.find(a => a.categories?.includes('Producer'));
    if (producer) return producer.name || producer.artist?.name || '';
    const str = currentSong.artistString;
    if (str.includes(' feat.')) return str.split(' feat.')[0];
    return str;
  })();

  // 状態に応じたスタイル計算
  let containerStyle: React.CSSProperties = {};
  
  if (isWatchPage && playerRect) {
    // WatchPage の VideoPlayer の位置にピタリと合わせる
    containerStyle = {
      position: 'fixed',
      top: playerRect.top,
      left: playerRect.left,
      width: playerRect.width,
      height: playerRect.height,
      borderRadius: '12px',
      zIndex: 10,
      background: '#000',
      transition: 'none', // スクロールに追従させるためtransitionは切る（あるいは高速化）
    };
  } else if (showMiniPlayer) {
    // MiniPlayer (PiP) モード
    containerStyle = {
      position: 'fixed',
      bottom: '16px',
      right: '16px',
      width: '400px',
      height: 'auto',
      maxWidth: 'calc(100vw - 32px)',
      borderRadius: '12px',
      zIndex: 50,
      boxShadow: '0 8px 32px rgba(0,0,0,0.6), 0 0 20px rgba(0,0,0,0.3)',
      background: 'var(--color-bg-secondary)',
      border: '1px solid var(--color-border)',
      transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
    };
  } else {
    // 非表示モード (アンマウントはしない)
    containerStyle = {
      position: 'fixed',
      top: '-9999px',
      left: '-9999px',
      width: '1px',
      height: '1px',
      opacity: 0,
      pointerEvents: 'none',
      zIndex: -1,
    };
  }

  return (
    <div className="overflow-hidden" style={containerStyle}>
      {/* プレイヤー本体 (iframe) */}
      <div 
        style={{ 
          width: '100%', 
          aspectRatio: '16/9', 
          background: '#000',
          cursor: showMiniPlayer ? 'pointer' : 'default',
        }}
        onClick={() => {
          if (showMiniPlayer) navigate(`/watch?v=${currentSong.id}`);
        }}
      >
        <PlayerEmbed />
      </div>

      {/* MiniPlayer コントロール (PiPモード時のみ表示) */}
      <div 
        className="flex items-center gap-2 px-3 py-2"
        style={{ 
           display: showMiniPlayer ? 'flex' : 'none',
           opacity: showMiniPlayer ? 1 : 0,
           transition: 'opacity 0.3s'
        }}
      >
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
          <button className="btn-ghost p-1.5 rounded-full" onClick={previous} title="前の曲">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
              <path d="M6 6h2v12H6zm3.5 6 8.5 6V6z" />
            </svg>
          </button>

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

          <button className="btn-ghost p-1.5 rounded-full" onClick={next} title="次の曲">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
              <path d="m6 18 8.5-6L6 6v12zM16 6v12h2V6h-2z" />
            </svg>
          </button>

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
