import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { usePlayerStore } from '../../stores/playerStore';
import { usePlayerInteractionStore } from '../../stores/playerInteractionStore';
import { usePlayerSwipeGesture } from '../../hooks/usePlayerSwipeGesture';
import PlayerEmbed from '../player/PlayerEmbed';
import { getPlaybackOwnership } from '../../services/playbackOwnership';

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
    closePlayer,
    shuffleEnabled, toggleShuffle,
    loopMode, toggleLoopMode,
    queue, queueDrawerOpen, toggleQueueDrawer,
  } = usePlayerStore();
  const swipeGestureEnabled = usePlayerInteractionStore(state => state.swipeGestureEnabled);
  const playbackOwnership = getPlaybackOwnership();
  const ownershipState = useSyncExternalStore(
    playbackOwnership.subscribe,
    playbackOwnership.getState,
    playbackOwnership.getState,
  );

  const isWatchPage = location.pathname === '/watch';
  const [isLeavingWatchPage, setIsLeavingWatchPage] = useState(false);

  useEffect(() => {
    if (!isWatchPage) {
      setIsLeavingWatchPage(false);
      return;
    }

    const handleInternalNavigation = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      const anchor = target.closest<HTMLAnchorElement>('a[href]');
      if (!anchor || anchor.target === '_blank' || anchor.hasAttribute('download')) return;
      const destination = new URL(anchor.href, window.location.href);
      if (destination.origin !== window.location.origin) return;
      const destinationIsWatch = destination.pathname.endsWith('/watch') || destination.pathname.endsWith('/playing');
      if (destinationIsWatch) return;

      // React Router may keep the old Watch route rendered while a lazy page is
      // loading. Move the persistent iframe to PiP immediately instead of
      // waiting for that transition to commit.
      setIsLeavingWatchPage(true);
    };

    document.addEventListener('click', handleInternalNavigation, { capture: true });
    return () => {
      document.removeEventListener('click', handleInternalNavigation, { capture: true });
    };
  }, [isWatchPage]);

  const renderAsWatchPage = isWatchPage && !isLeavingWatchPage && !!playerRect;
  // WatchPage 以外では、別タブが再生を取得したと確定した場合だけ隠す。
  // `none` は初期化・SPA遷移・page lifecycleの短い中間状態でも現れるため、
  // 再生中ならlocal claimが反映されるまでPiPを維持する。停止状態の別タブに
  // 永続queueだけが復元された場合は表示しない。
  const hasLocalPlayback = ownershipState === 'local' || (ownershipState === 'none' && isPlaying);
  const showMiniPlayer = !renderAsWatchPage && !!currentSong && hasLocalPlayback;
  const canShuffle = queue.length > 1;
  const handleSwipe = useCallback((direction: 'left' | 'right' | 'up') => {
    if (direction === 'left') next();
    else if (direction === 'right') previous();
    else navigate(`/watch?v=${currentSong?.id ?? ''}`);
  }, [currentSong?.id, navigate, next, previous]);
  const swipeHandlers = usePlayerSwipeGesture({
    enabled: showMiniPlayer && swipeGestureEnabled,
    onSwipe: handleSwipe,
  });

  const producerName = (() => {
    if (!currentSong) return '';
    const producer = currentSong.artists?.find(a => a.categories?.includes('Producer'));
    if (producer) return producer.name || producer.artist?.name || '';
    const str = currentSong.artistString;
    if (str.includes(' feat.')) return str.split(' feat.')[0];
    return str;
  })();
  const containerStyle: React.CSSProperties = (() => {
    if (currentSong && renderAsWatchPage && playerRect) {
      // WatchPage の VideoPlayer の位置にピタリと合わせる
      // absolute にすることで、スクロール時に自動追従し、JSによる遅延を防ぐ
      return {
      position: 'absolute',
      top: playerRect.top,
      left: playerRect.left,
      width: playerRect.width,
      height: playerRect.height,
      borderRadius: '12px',
      zIndex: 10,
      background: '#000',
      transition: 'none', // スクロールに追従させるためtransitionは切る（あるいは高速化）
      };
    }

    if (showMiniPlayer) {
      // MiniPlayer (PiP) モード — スタイルは .global-mini-player CSS で強化される
      return {
      position: 'fixed',
      bottom: '16px',
      right: '16px',
      width: '400px',
      height: 'auto',
      maxWidth: 'calc(100vw - 32px)',
      borderRadius: '14px',
      zIndex: 50,
      boxShadow: '0 8px 32px rgba(0,0,0,0.6), 0 0 20px rgba(0,0,0,0.3)',
      background: 'var(--color-bg-secondary)',
      border: '1px solid var(--color-border)',
      transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
      };
    }

    // 非表示モード (アンマウントはしない)
    return {
      position: 'fixed',
      top: '-9999px',
      left: '-9999px',
      width: '1px',
      height: '1px',
      opacity: 0,
      pointerEvents: 'none',
      zIndex: -1,
    };
  })();

  return (
    <div className={`overflow-hidden${showMiniPlayer ? ' global-mini-player' : ''}`} data-testid="global-player" style={containerStyle}>
      {/* プレイヤー本体 (iframe) */}
      <div 
        style={{ 
          width: '100%', 
          aspectRatio: '16/9', 
          background: '#000',
          cursor: showMiniPlayer ? 'pointer' : 'default',
        }}
        onClick={() => {
          if (showMiniPlayer && currentSong) navigate(`/watch?v=${currentSong.id}`);
        }}
      >
        <PlayerEmbed />
      </div>

      {/* MiniPlayer コントロール (PiPモード時のみ表示) */}
      {currentSong && <div
        className="mini-player-controls"
        data-testid="mini-player-gesture-surface"
        {...swipeHandlers}
        style={{ 
           display: showMiniPlayer ? 'flex' : 'none',
           flexDirection: 'column',
           gap: '0.25rem',
           padding: '0.5rem 0.75rem 0.625rem',
           opacity: showMiniPlayer ? 1 : 0,
           transition: 'opacity 0.3s',
           touchAction: 'pan-y',
        }}
      >
        {/* 1行目: 曲情報 + 閉じるボタン */}
        <div className="flex items-center gap-2">
          <div
            className="flex-1 min-w-0 cursor-pointer"
            data-testid="mini-player-swipe-origin"
            onClick={() => navigate(`/watch?v=${currentSong.id}`)}
          >
            <p
              className="text-sm font-medium truncate"
              style={{ color: 'var(--color-text-primary)' }}
            >
              {currentSong.name}
            </p>
            <p className="text-xs truncate" style={{ color: 'var(--color-text-secondary)' }}>
              {producerName}
            </p>
          </div>
          <button
            className="btn-ghost p-1 rounded-full mini-player-control"
            data-testid="mini-player-close"
            onClick={(event) => {
              event.stopPropagation();
              closePlayer();
            }}
            title="ミニプレイヤーを閉じる"
            aria-label="ミニプレイヤーを閉じる"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
            </svg>
          </button>
        </div>

        {/* 2行目: 再生コントロール */}
        <div className="flex items-center justify-between">
          {/* 左: セカンダリコントロール */}
          <div className="flex items-center gap-0.5">
            <button
              className="btn-ghost p-1.5 rounded-full mini-player-control mini-player-optional"
              onClick={toggleShuffle}
              disabled={!canShuffle && !shuffleEnabled}
              title={shuffleEnabled ? 'シャッフルOFF' : 'シャッフルON'}
              style={{ color: shuffleEnabled ? 'var(--color-accent-cyan)' : undefined, opacity: canShuffle || shuffleEnabled ? 1 : 0.45 }}
              aria-label={shuffleEnabled ? 'シャッフルOFF' : canShuffle ? 'シャッフルON' : 'シャッフル不可'}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
                <path d="M10.59 9.17 5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.41-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z"/>
              </svg>
            </button>

            <button
              className="btn-ghost p-1.5 rounded-full relative mini-player-control mini-player-optional"
              onClick={toggleLoopMode}
              title={loopMode === 'none' ? 'ループOFF' : loopMode === 'all' ? '全体ループ' : '1曲ループ'}
              style={{ color: loopMode !== 'none' ? 'var(--color-accent-cyan)' : undefined }}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
                <path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z"/>
              </svg>
              {loopMode === 'one' && (
                <span className="absolute -top-0.5 -right-0.5 text-[8px] font-bold leading-none w-3.5 h-3.5 rounded-full flex items-center justify-center"
                      style={{ background: 'var(--color-accent-cyan)', color: '#000' }}>1</span>
              )}
            </button>
          </div>

          {/* 中央: メインコントロール */}
          <div className="flex items-center gap-1">
            <button className="btn-ghost p-1.5 rounded-full mini-player-control" onClick={previous} title="前の曲" aria-label="前の曲">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                <path d="M6 6h2v12H6zm3.5 6 8.5 6V6z" />
              </svg>
            </button>

            <button
              className="rounded-full flex items-center justify-center mini-player-control mini-player-play"
              style={{
                width: 36,
                height: 36,
                background: 'var(--gradient-primary)',
                boxShadow: isPlaying ? '0 0 12px rgba(6,214,160,0.35)' : 'none',
              }}
              onClick={() => isPlaying ? pause() : resume()}
              title={isPlaying ? '一時停止' : '再生'}
              aria-label={isPlaying ? '一時停止' : '再生'}
            >
              {isPlaying ? (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="white">
                  <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" />
                </svg>
              ) : (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="white" style={{ marginLeft: 2 }}>
                  <path d="M8 5v14l11-7z" />
                </svg>
              )}
            </button>

            <button className="btn-ghost p-1.5 rounded-full mini-player-control" onClick={next} title="次の曲" aria-label="次の曲">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                <path d="m6 18 8.5-6L6 6v12zM16 6v12h2V6h-2z" />
              </svg>
            </button>
          </div>

          {/* 右: キュー・全画面 */}
          <div className="flex items-center gap-0.5">
            <button
              className="btn-ghost p-1.5 rounded-full relative mini-player-control"
              data-testid="mini-player-queue"
              onClick={toggleQueueDrawer}
              title="再生キュー"
              aria-label="再生キュー"
              style={{ color: queueDrawerOpen ? 'var(--color-accent-purple)' : undefined }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
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

            <button
              className="btn-ghost p-1.5 rounded-full mini-player-control"
              onClick={() => navigate(`/watch?v=${currentSong.id}`)}
              title="全画面で表示"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <path d="M19 19H5V5h7V3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2v-7h-2v7zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z" />
              </svg>
            </button>
          </div>
        </div>
      </div>}
    </div>
  );
}
