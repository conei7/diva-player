import { lazy, Suspense, useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { CSSProperties, RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useLocation, useNavigate } from 'react-router';
import { usePlayerStore } from '../../stores/playerStore';
import { usePlayerInteractionStore } from '../../stores/playerInteractionStore';
import { useLanguageStore } from '../../stores/languageStore';
import { showToast } from '../../stores/toastStore';
import { usePlayerSwipeGesture } from '../../hooks/usePlayerSwipeGesture';
import { FINE_HOVER_MEDIA_QUERY, MOBILE_MEDIA_QUERY, useMediaQuery } from '../../hooks/useMediaQuery';
import PlayerEmbed from '../player/PlayerEmbed';
import { getPlaybackOwnership } from '../../services/playbackOwnership';
import { translateSourceText } from '../../i18n';
import { isWatchPath, watchPath } from '../../utils/routes';
import { serviceLabel } from '../../utils/songMeta';
import { cx } from '../ui/overlay';
import { DeferredBoundary } from '../layout/RouteErrorBoundary';
import { whenIdle } from '../../routes/routeLoaders';
import SleepTimerWatcher from './SleepTimer';
import { createPlaybackFailureTracker, type PlaybackNotice } from './playbackNotices';
import { isSilentVolume } from './playerMute';

// The mini player's controls are only drawn once a song is loaded, so they stay out of the initial
// JavaScript (DESIGN_SPEC §1-12). The iframe (PlayerEmbed) is never inside their Suspense boundary.
const loadMiniPlayerControls = () => import('./MiniPlayerControls');
const loadProgressLine = () => import('./ProgressLine');
const loadMuteBadge = () => import('./MuteBadge');
const MiniPlayerControls = lazy(loadMiniPlayerControls);
const ProgressLine = lazy(loadProgressLine);
const MuteBadge = lazy(loadMuteBadge);
const preloadMiniPlayerControls = () => {
  void loadMiniPlayerControls().catch(() => undefined);
  void loadProgressLine().catch(() => undefined);
  void loadMuteBadge().catch(() => undefined);
};

/**
 * While `active`, every iframe under `root` gets tabindex="-1": Tab skips the embedded player and its
 * own controls (dozens of stops in YouTube's), while clicks still reach it. Embedded players come
 * and go (YouTube builds its own iframe, each video gets a new one), so new iframes are caught too.
 * The attribute is the only change; the iframes are never moved or remounted.
 */
function useIframesOutOfTabOrder(root: RefObject<HTMLElement | null>, active: boolean) {
  useEffect(() => {
    const element = root.current;
    if (!element || !active) return undefined;
    const apply = () => element.querySelectorAll('iframe:not([tabindex="-1"])').forEach(iframe => {
      iframe.setAttribute('tabindex', '-1');
    });
    apply();
    const observer = new MutationObserver(apply);
    observer.observe(element, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      element.querySelectorAll('iframe[tabindex="-1"]').forEach(iframe => iframe.removeAttribute('tabindex'));
    };
  }, [active, root]);
}

/**
 * Tells the user when playback failed and what the player did about it (DESIGN_SPEC §6.2.1):
 * switched to another video, skipped to the next song (［戻る］) or stopped (［再試行］).
 */
function usePlaybackFailureToasts(isWatchPage: boolean) {
  const onWatchPageRef = useRef(isWatchPage);
  onWatchPageRef.current = isWatchPage;

  useEffect(() => {
    const announce = (notice: PlaybackNotice) => {
      const language = useLanguageStore.getState().language;
      if (notice.kind === 'switched') {
        showToast(notice.from === notice.to
          ? translateSourceText(language, '再生できないため、別の動画に切り替えました')
          : translateSourceText(language, '{from}で再生できないため、{to}に切り替えました', {
            from: serviceLabel(notice.from, language),
            to: serviceLabel(notice.to, language),
          }));
        return;
      }
      if (notice.kind === 'skipped') {
        showToast(translateSourceText(language, '再生できなかったため次の曲へ進みました'), notice.canGoBack ? {
          action: {
            label: translateSourceText(language, '戻る'),
            onAction: () => {
              const state = usePlayerStore.getState();
              // Straight back to the song that failed (previous() would only rewind once the
              // next song has played for a few seconds).
              if (state.queue[notice.queueIndex]?.id === notice.songId) state.jumpToIndex(notice.queueIndex);
              else state.previous();
            },
          },
        } : undefined);
        return;
      }
      // Nothing played. The song page explains a song without any video in the player frame.
      if (!notice.canRetry && onWatchPageRef.current) return;
      showToast(translateSourceText(language, '再生できませんでした'), notice.canRetry ? {
        action: {
          label: translateSourceText(language, '再試行'),
          onAction: () => {
            const state = usePlayerStore.getState();
            if (state.currentSong?.id === notice.songId) state.playSong(state.currentSong, true, false);
          },
        },
      } : undefined);
    };
    const tracker = createPlaybackFailureTracker({
      onNotice: announce,
      // The error only exists to be reported; clear it so the same failure is noticed next time.
      onSettled: error => {
        const state = usePlayerStore.getState();
        if (state.error === error) state.setError(null);
      },
    });
    const unsubscribe = usePlayerStore.subscribe((state, prev) => tracker.update(state, prev));
    return () => {
      unsubscribe();
      tracker.dispose();
    };
  }, []);
}

/**
 * GlobalPlayer - 永続化されたプレイヤーコンポーネント
 *
 * SPA遷移中（/watch <-> / 等）に iframe を絶対にアンマウントさせず、
 * 動画の再生状態を維持するための工夫。
 *
 * 1. WatchPage表示時: VideoPlayerのDOMRect (playerRect) に合わせて絶対配置し、メインプレイヤーのフリをする。
 *    曲を切り替える間や再生できる動画が無い曲（動画枠が無い間）は前の位置に残し、aria-hidden と inert を付ける。
 * 2. それ以外 (HomePage等) で再生中: 右下のミニプレイヤーとして振る舞う（モバイルは下部ナビの上・全幅）。
 *    埋め込みの iframe は tabindex=-1（Tab はミニプレイヤーの操作だけを通る。クリックは今までどおり iframe へ）。
 * 3. どちらでもない: 画面外に置き、aria-hidden と inert で読み上げ・フォーカスから外す。
 *    アンマウントも display:none もしない（再生を止めないため）。
 *
 * DOM では body の末尾（ページの後ろ）に置く（portal。置き場所は最初から固定なので iframe は付け替わらない）。
 * キーボードでは上部バー・ガイド・本文の後にミニプレイヤーが来る（YouTube と同じ）。
 */
export default function GlobalPlayer() {
  const location = useLocation();
  const navigate = useNavigate();
  const currentSong = usePlayerStore(state => state.currentSong);
  const playerRect = usePlayerStore(state => state.playerRect);
  const isPlaying = usePlayerStore(state => state.isPlaying);
  const volume = usePlayerStore(state => state.volume);
  const next = usePlayerStore(state => state.next);
  const previous = usePlayerStore(state => state.previous);
  const swipeGestureEnabled = usePlayerInteractionStore(state => state.swipeGestureEnabled);
  const isMobile = useMediaQuery(MOBILE_MEDIA_QUERY);
  const finePointer = useMediaQuery(FINE_HOVER_MEDIA_QUERY);
  const playbackOwnership = getPlaybackOwnership();
  const ownershipState = useSyncExternalStore(
    playbackOwnership.subscribe,
    playbackOwnership.getState,
    playbackOwnership.getState,
  );

  const isWatchPage = isWatchPath(location.pathname);
  const [isLeavingWatchPage, setIsLeavingWatchPage] = useState(false);
  const lastWatchPlayerRectRef = useRef<DOMRect | null>(null);

  usePlaybackFailureToasts(isWatchPage);

  useEffect(() => {
    if (isWatchPage && playerRect) lastWatchPlayerRectRef.current = playerRect;
  }, [isWatchPage, playerRect]);

  useEffect(() => {
    if (!isWatchPage) {
      setIsLeavingWatchPage(false);
      lastWatchPlayerRectRef.current = null;
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

  // Watch-to-Watch song changes briefly unmount the placeholder while the new
  // song details load. Keep the last full-player rectangle through that gap;
  // never reinterpret a missing rectangle on /watch as a request for PiP.
  const watchPlayerRect = isWatchPage
    ? playerRect ?? lastWatchPlayerRectRef.current
    : null;
  const renderAsWatchPage = isWatchPage && !isLeavingWatchPage && !!watchPlayerRect;
  // WatchPage 以外では、別タブが再生を取得したと確定した場合だけ隠す。
  // `none` は初期化・SPA遷移・page lifecycleの短い中間状態でも現れるため、
  // 再生中ならlocal claimが反映されるまでPiPを維持する。停止状態の別タブに
  // 永続queueだけが復元された場合は表示しない。
  const hasLocalPlayback = ownershipState === 'local' || (ownershipState === 'none' && isPlaying);
  const showMiniPlayer = (!isWatchPage || isLeavingWatchPage)
    && !renderAsWatchPage
    && !!currentSong
    && hasLocalPlayback;
  const hiddenOffscreen = !(currentSong && renderAsWatchPage) && !showMiniPlayer;
  // No placeholder on the song page (a song without a playable video, or between two songs): the
  // player keeps its last spot under the page's own frame, out of reach like when parked off screen.
  const coveredOnWatchPage = renderAsWatchPage && !playerRect;
  const unreachable = hiddenOffscreen || coveredOnWatchPage;
  const videoVisible = !!currentSong && (showMiniPlayer || (renderAsWatchPage && !coveredOnWatchPage));
  const floatingPlayerRef = useRef<HTMLDivElement>(null);
  // The mini player has its own controls; on the song page the video's own controls stay reachable.
  useIframesOutOfTabOrder(floatingPlayerRef, showMiniPlayer);
  useEffect(() => {
    const element = floatingPlayerRef.current;
    const update = () => document.documentElement.style.setProperty(
      '--floating-player-clearance', `${showMiniPlayer && element ? Math.ceil(element.getBoundingClientRect().height) + 16 : 0}px`,
    );
    update();
    const observer = new ResizeObserver(update);
    if (element && showMiniPlayer) observer.observe(element);
    return () => {
      observer.disconnect();
      document.documentElement.style.removeProperty('--floating-player-clearance');
    };
  }, [showMiniPlayer]);
  const currentSongId = currentSong?.id ?? null;
  // Fetch the controls as soon as something is loaded (otherwise when the browser is idle), so they
  // are ready when the mini player shows and are not left to download late in a long session.
  const hasSong = currentSongId !== null;
  useEffect(() => {
    if (!hasSong) return whenIdle(preloadMiniPlayerControls);
    preloadMiniPlayerControls();
    return undefined;
  }, [hasSong]);
  const openSongPage = useCallback(() => {
    if (currentSongId !== null) navigate(watchPath(currentSongId));
  }, [currentSongId, navigate]);
  const handleSwipe = useCallback((direction: 'left' | 'right' | 'up') => {
    if (direction === 'left') next();
    else if (direction === 'right') previous();
    else openSongPage();
  }, [next, openSongPage, previous]);
  const swipeHandlers = usePlayerSwipeGesture({
    enabled: showMiniPlayer && swipeGestureEnabled,
    onSwipe: handleSwipe,
  });
  // The badge goes away once pressed: keep the keyboard on the mini player (its play button).
  const keepFocusAfterUnmute = useCallback((badgeHadFocus: boolean) => {
    if (!badgeHadFocus) return;
    floatingPlayerRef.current?.querySelector<HTMLElement>('[data-testid="global-mini-player-toggle"]')?.focus();
  }, []);

  const containerStyle: CSSProperties | undefined = (() => {
    if (currentSong && renderAsWatchPage && watchPlayerRect) {
      // WatchPage の VideoPlayer の位置にピタリと合わせる
      // absolute にすることで、スクロール時に自動追従し、JSによる遅延を防ぐ
      return {
        position: 'absolute',
        top: watchPlayerRect.top,
        left: watchPlayerRect.left,
        width: watchPlayerRect.width,
        height: watchPlayerRect.height,
        // 640px 未満の再生ページは動画枠が全幅・角丸なし（watch と合わせる）
        borderRadius: isMobile ? 0 : 12,
        zIndex: 10,
        background: '#000',
      };
    }

    // ミニプレイヤーの位置・大きさ・地の色は .global-mini-player（index.css の area:player）
    if (showMiniPlayer) return undefined;

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

  return createPortal(
    <div
      ref={floatingPlayerRef}
      className={cx('overflow-hidden', showMiniPlayer && 'global-mini-player')}
      data-testid="global-player"
      style={containerStyle}
      aria-hidden={unreachable || undefined}
      inert={unreachable || undefined}
    >
      <DeferredBoundary>
        <Suspense fallback={null}>
          {/* Nothing can be heard (M, or a volume of 0): the only sign of it, on the video itself. */}
          {videoVisible && isSilentVolume(volume) && (
            <MuteBadge inset={showMiniPlayer ? 'mini' : 'page'} onUnmuted={keepFocusAfterUnmute} />
          )}
        </Suspense>
      </DeferredBoundary>

      {/* プレイヤー本体 (iframe) */}
      <div
        className={cx('w-full bg-black', renderAsWatchPage ? 'h-full' : 'aspect-video', showMiniPlayer && 'cursor-pointer')}
        onClick={() => {
          if (showMiniPlayer) openSongPage();
        }}
      >
        <PlayerEmbed />
      </div>

      <DeferredBoundary>
        <Suspense fallback={null}>
          {showMiniPlayer && currentSong && <ProgressLine seekable={finePointer && !isMobile} />}
          {/*
            Off the song page the controls stay in the DOM while a song is loaded (hidden until the
            mini player shows), as before. On the song page they are left out entirely: the page has
            its own 前の曲 / 次の曲 / ⋮ with the same labels.
          */}
          {currentSong && (!isWatchPage || isLeavingWatchPage) && (
            <MiniPlayerControls
              visible={showMiniPlayer}
              mobile={isMobile}
              onOpenSongPage={openSongPage}
              swipeHandlers={swipeHandlers}
            />
          )}
        </Suspense>
      </DeferredBoundary>
      <SleepTimerWatcher />
    </div>,
    document.body,
  );
}
