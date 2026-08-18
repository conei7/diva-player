/// <reference types="@types/youtube" />
import { useEffect, useRef, useCallback } from 'react';
import { usePlayerStore } from '../../stores/playerStore';
import { useProgressStore } from '../../stores/progressStore';
import { getPlaybackOwnership } from '../../services/playbackOwnership';
import { createPlaybackAttemptController, type PlaybackAttemptToken } from '../../services/playbackAttempt';
import { usePlaybackWakeRecovery } from '../../hooks/usePlaybackWakeRecovery';
import {
  buildNicoEmbedUrl,
  createNicoMuteMessage,
  createNicoPlaybackMessage,
  createNicoProgressTracker,
  createNicoSeekMessage,
  createNicoVolumeMessage,
  parseNicoPlayerMessage,
} from '../../services/nicoPlayerSync';
import { getPlaybackRecoveryCheckDelayMs, hasReachedPlaybackEnd } from '../../services/playbackEndRecovery';
import { getSafeWakePosition } from '../../services/playbackWakeRecovery';
import SoundCloudEmbed from './SoundCloudEmbed';
import BilibiliEmbed from './BilibiliEmbed';

/**
 * PlayerEmbed - YouTube / ニコニコ / SoundCloud / Bilibili 埋め込みプレイヤー
 *
 * 選択されたPVのサービスに応じて適切なiframeを表示。
 * YouTube: IFrame Player API を使用して再生制御。
 * ニコニコ: connector protocolで再生状態・音量・進捗を同期。
 * SoundCloud: Widget APIで再生状態・音量・進捗を同期。
 * Bilibili: 公式iframeとネイティブ操作を使用。
 */

// YouTube IFrame API の型
declare global {
  interface Window {
    YT: {
      Player: new (elementId: string, options: YT.PlayerOptions) => YT.Player;
      PlayerState: { UNSTARTED: number; ENDED: number; PLAYING: number; PAUSED: number; BUFFERING: number; CUED: number };
    };
    onYouTubeIframeAPIReady: () => void;
  }
}

/**
 * NicoEmbed - ニコニコ動画専用コンポーネント
 *
 * embed.nicovideo.jp の postMessage API でプログレス同期を試み、
 * 失敗した場合はタイマーベースのフォールバックで経過時間を推定する。
 */
function NicoEmbed({ pvId, name, duration: songDuration, isPlaying }: { pvId: string; name?: string; duration?: number; isPlaying: boolean }) {
  const { volume, setIsPlaying, next, markPVHealthy, tryNextPV } = usePlayerStore();
  const markCurrentPVHealthy = useCallback(() => {
    const pv = usePlayerStore.getState().currentPV;
    if (pv) markPVHealthy(pv);
  }, [markPVHealthy]);
  const setProgress = useProgressStore(s => s.setProgress);
  const setDuration = useProgressStore(s => s.setDuration);
  const seekTarget = usePlayerStore(s => s.seekTarget);
  const clearSeekTarget = usePlayerStore(s => s.clearSeekTarget);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const iframeReadyRef = useRef(false);
  const initialAutoplayRef = useRef(isPlaying);
  const playerIdRef = useRef(`diva-player-${pvId}-${Date.now().toString(36)}`);
  const requestedPlayingRef = useRef(isPlaying);
  const autoplayMutedRef = useRef(initialAutoplayRef.current);
  const embedUrl = buildNicoEmbedUrl(pvId, initialAutoplayRef.current, playerIdRef.current);
  const NICO_ORIGIN = 'https://embed.nicovideo.jp';

  const timerRef = useRef<number | null>(null);
  const volumeRetryRef = useRef<number | null>(null);
  const playTimerRef = useRef<number | null>(null);
  const attemptControllerRef = useRef(createPlaybackAttemptController());
  const attemptTokenRef = useRef<PlaybackAttemptToken | null>(null);
  const trackerRef = useRef(createNicoProgressTracker());
  const durationRef = useRef(songDuration);
  const advancedRef = useRef(false);

  const applySeek = useCallback((target: number) => {
    if (!iframeReadyRef.current || !iframeRef.current?.contentWindow) return false;
    iframeRef.current.contentWindow.postMessage(
      createNicoSeekMessage(playerIdRef.current, target),
      NICO_ORIGIN,
    );
    trackerRef.current.confirm(target);
    setProgress(target);
    clearSeekTarget();
    return true;
  }, [clearSeekTarget, setProgress]);

  const sendVolume = useCallback(() => {
    iframeRef.current?.contentWindow?.postMessage(
      createNicoVolumeMessage(playerIdRef.current, volume),
      NICO_ORIGIN,
    );
  }, [volume]);

  const sendPlaybackState = useCallback((playing: boolean) => {
    iframeRef.current?.contentWindow?.postMessage(
      createNicoPlaybackMessage(playerIdRef.current, playing),
      NICO_ORIGIN,
    );
  }, []);

  const sendMuted = useCallback((muted: boolean) => {
    iframeRef.current?.contentWindow?.postMessage(
      createNicoMuteMessage(playerIdRef.current, muted),
      NICO_ORIGIN,
    );
  }, []);

  const prepareAndSendPlaybackState = useCallback((playing: boolean) => {
    if (playing && autoplayMutedRef.current) sendMuted(true);
    sendPlaybackState(playing);
  }, [sendMuted, sendPlaybackState]);

  const clearPlaybackRetry = useCallback(() => {
    if (playTimerRef.current === null) return;
    window.clearTimeout(playTimerRef.current);
    playTimerRef.current = null;
  }, []);

  const cancelPlaybackAttempt = useCallback(() => {
    attemptControllerRef.current.cancel();
    attemptTokenRef.current = null;
  }, []);

  const ensurePlaybackAttempt = useCallback(() => {
    if (!requestedPlayingRef.current || attemptTokenRef.current) return;
    attemptTokenRef.current = attemptControllerRef.current.start(pvId, () => {
      attemptTokenRef.current = null;
      if (requestedPlayingRef.current) tryNextPV();
    });
  }, [pvId, tryNextPV]);

  const completePlaybackAttempt = useCallback(() => {
    const attempt = attemptTokenRef.current;
    if (!attempt) return;
    attemptControllerRef.current.complete(attempt);
    attemptTokenRef.current = null;
  }, []);

  const schedulePlaybackRetry = useCallback((initialDelayMs = 750) => {
    clearPlaybackRetry();
    if (!requestedPlayingRef.current || !iframeReadyRef.current) return;
    const retry = () => {
      playTimerRef.current = null;
      if (!requestedPlayingRef.current || !iframeReadyRef.current) return;
      prepareAndSendPlaybackState(true);
      ensurePlaybackAttempt();
      playTimerRef.current = window.setTimeout(retry, 1_000);
    };
    playTimerRef.current = window.setTimeout(retry, initialDelayMs);
  }, [clearPlaybackRetry, ensurePlaybackAttempt, prepareAndSendPlaybackState]);

  const scheduleVolumeSync = useCallback(() => {
    sendVolume();
    if (volumeRetryRef.current !== null) window.clearTimeout(volumeRetryRef.current);
    volumeRetryRef.current = window.setTimeout(() => {
      volumeRetryRef.current = null;
      sendVolume();
    }, 500);
  }, [sendVolume]);

  const stopTimer = useCallback(() => {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
  }, []);

  const advanceOnce = useCallback(() => {
    if (advancedRef.current) return;
    advancedRef.current = true;
    trackerRef.current.setPlaying(false);
    stopTimer();
    next();
  }, [next, stopTimer]);

  const startTimer = useCallback(() => {
    stopTimer();
    trackerRef.current.setPlaying(true);
    timerRef.current = window.setInterval(() => {
      const current = trackerRef.current.current();
      setProgress(current);
      if (hasReachedPlaybackEnd(current, durationRef.current ?? 0)) advanceOnce();
    }, 500);
  }, [advanceOnce, setProgress, stopTimer]);

  // マウント時に進捗と再生要求を初期化する。
  useEffect(() => {
    setProgress(0);
    advancedRef.current = false;
    durationRef.current = songDuration;
    trackerRef.current.reset();
    trackerRef.current.setDuration(songDuration);
    if (songDuration && songDuration > 0) setDuration(songDuration);
    ensurePlaybackAttempt();
    return () => {
      iframeReadyRef.current = false;
      stopTimer();
      cancelPlaybackAttempt();
      if (volumeRetryRef.current !== null) window.clearTimeout(volumeRetryRef.current);
      clearPlaybackRetry();
      volumeRetryRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pvId]);

  // iframeロード後に現在のconnector protocolで再生状態を同期する。
  // loadCompleteが後から届く場合にもmessage handler側で再送する。
  const handleIframeLoad = useCallback(() => {
    iframeReadyRef.current = true;
    if (songDuration && songDuration > 0) setDuration(songDuration);
    scheduleVolumeSync();
    prepareAndSendPlaybackState(requestedPlayingRef.current);
    ensurePlaybackAttempt();
    schedulePlaybackRetry();
    const pendingSeek = usePlayerStore.getState().seekTarget;
    if (pendingSeek !== null) applySeek(pendingSeek);
  }, [applySeek, ensurePlaybackAttempt, prepareAndSendPlaybackState, schedulePlaybackRetry, scheduleVolumeSync, setDuration, songDuration]);

  useEffect(() => {
    requestedPlayingRef.current = isPlaying;
    prepareAndSendPlaybackState(isPlaying);
    if (isPlaying) {
      ensurePlaybackAttempt();
      schedulePlaybackRetry();
    } else {
      clearPlaybackRetry();
      cancelPlaybackAttempt();
    }
  }, [cancelPlaybackAttempt, clearPlaybackRetry, ensurePlaybackAttempt, isPlaying, prepareAndSendPlaybackState, schedulePlaybackRetry]);

  useEffect(() => {
    if (seekTarget !== null) applySeek(seekTarget);
  }, [applySeek, seekTarget]);

  // ニコニコからのpostMessageを受信
  useEffect(() => {
    const handler = (e: MessageEvent) => {
      // 許可originと、このコンポーネントが作ったiframeの両方を確認する。
      if (e.origin !== NICO_ORIGIN || e.source !== iframeRef.current?.contentWindow) return;
      const message = parseNicoPlayerMessage(e.data);
      if (!message) return;
      switch (message.type) {
        case 'ready': {
          if (message.duration) {
            durationRef.current = message.duration;
            trackerRef.current.setDuration(message.duration);
            setDuration(message.duration);
          }
          scheduleVolumeSync();
          prepareAndSendPlaybackState(requestedPlayingRef.current);
          ensurePlaybackAttempt();
          schedulePlaybackRetry();
          break;
        }
        case 'progress': {
          const confirmsPlayback = message.seconds > 0 && attemptTokenRef.current !== null;
          trackerRef.current.confirm(message.seconds);
          const current = trackerRef.current.current();
          setProgress(current);
          if (confirmsPlayback) {
            clearPlaybackRetry();
            markCurrentPVHealthy();
            completePlaybackAttempt();
            requestedPlayingRef.current = true;
            setIsPlaying(true);
            startTimer();
          }
          if (hasReachedPlaybackEnd(current, durationRef.current ?? 0)) advanceOnce();
          break;
        }
        case 'playing':
          clearPlaybackRetry();
          markCurrentPVHealthy();
          completePlaybackAttempt();
          requestedPlayingRef.current = true;
          setIsPlaying(true);
          if (autoplayMutedRef.current && navigator.userActivation?.hasBeenActive) {
            autoplayMutedRef.current = false;
            sendMuted(false);
            scheduleVolumeSync();
          }
          startTimer();
          break;
        case 'paused':
          if (requestedPlayingRef.current) {
            schedulePlaybackRetry(500);
            break;
          }
          trackerRef.current.setPlaying(false);
          setProgress(trackerRef.current.current());
          setIsPlaying(false);
          stopTimer();
          break;
        case 'ended':
          advanceOnce();
          break;
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [advanceOnce, clearPlaybackRetry, completePlaybackAttempt, ensurePlaybackAttempt, markCurrentPVHealthy, prepareAndSendPlaybackState, schedulePlaybackRetry, scheduleVolumeSync, sendMuted, setProgress, setDuration, setIsPlaying, startTimer, stopTimer]);

  useEffect(() => {
    const restoreAutoplayAudio = () => {
      if (!autoplayMutedRef.current || !usePlayerStore.getState().isPlaying) return;
      autoplayMutedRef.current = false;
      sendMuted(false);
      scheduleVolumeSync();
    };
    window.addEventListener('pointerdown', restoreAutoplayAudio, { capture: true });
    window.addEventListener('keydown', restoreAutoplayAudio, { capture: true });
    return () => {
      window.removeEventListener('pointerdown', restoreAutoplayAudio, { capture: true });
      window.removeEventListener('keydown', restoreAutoplayAudio, { capture: true });
    };
  }, [scheduleVolumeSync, sendMuted]);

  const recoverNicoPlayback = useCallback(() => {
    const state = usePlayerStore.getState();
    if (!state.isPlaying || getPlaybackOwnership().getState() !== 'local') return;
    // The tracker uses wall time between confirmed Nico events. A suspended
    // browser must not count that gap as listened playback, so anchor it to the
    // last UI-confirmed position before asking the iframe to resume.
    const rememberedProgress = useProgressStore.getState().progress;
    trackerRef.current.confirm(rememberedProgress);
    if (hasReachedPlaybackEnd(rememberedProgress, durationRef.current ?? 0)) {
      advanceOnce();
      return;
    }
    requestedPlayingRef.current = true;
    prepareAndSendPlaybackState(true);
    schedulePlaybackRetry();
    startTimer();
  }, [advanceOnce, prepareAndSendPlaybackState, schedulePlaybackRetry, startTimer]);
  usePlaybackWakeRecovery(recoverNicoPlayback);

  // ボリューム同期。iframeロード前に送ったメッセージを補うため遅延再送する。
  useEffect(() => {
    scheduleVolumeSync();
  }, [scheduleVolumeSync]);

  return (
    <iframe
      ref={iframeRef}
      src={embedUrl}
      title={name || pvId}
      className="w-full h-full"
      allow="autoplay; fullscreen"
      allowFullScreen
      style={{ border: 'none' }}
      onLoad={handleIframeLoad}
    />
  );
}


let ytApiLoaded = false;
let ytApiLoading = false;

function loadYouTubeAPI(): Promise<void> {
  if (ytApiLoaded) return Promise.resolve();
  if (ytApiLoading) {
    return new Promise((resolve) => {
      const check = setInterval(() => {
        if (ytApiLoaded) {
          clearInterval(check);
          resolve();
        }
      }, 100);
    });
  }

  ytApiLoading = true;
  return new Promise((resolve) => {
    const tag = document.createElement('script');
    tag.src = 'https://www.youtube.com/iframe_api';
    const firstScript = document.getElementsByTagName('script')[0];
    firstScript.parentNode?.insertBefore(tag, firstScript);

    window.onYouTubeIframeAPIReady = () => {
      ytApiLoaded = true;
      ytApiLoading = false;
      resolve();
    };
  });
}

export default function PlayerEmbed() {
  const { currentSong, currentPV, playbackSequence, isPlaying, volume, seekTarget, clearSeekTarget, setIsPlaying, setError, setVolume, tryNextPV, markPVHealthy } = usePlayerStore();
  const setProgress = useProgressStore(s => s.setProgress);
  const setDuration = useProgressStore(s => s.setDuration);
  const ytPlayerRef = useRef<YT.Player | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const progressTimerRef = useRef<number | null>(null);
  const volumeSyncTimerRef = useRef<number | null>(null);
  const endRecoveryTimerRef = useRef<number | null>(null);
  const advancedPVRef = useRef<string | null>(null);
  const attemptControllerRef = useRef(createPlaybackAttemptController());
  const youtubeReadyRef = useRef(false);
  const youtubeDesiredVideoRef = useRef<{
    pvId: string;
    songId: number | null;
    playbackSequence: number;
    attempt: PlaybackAttemptToken;
  } | null>(null);
  const volumeRef = useRef(volume);
  const youtubeAutoplayMutedRef = useRef(false);
  const ownershipRef = useRef<ReturnType<typeof getPlaybackOwnership> | null>(null);

  useEffect(() => {
    volumeRef.current = volume;
  }, [volume]);

  // YouTubeのネイティブ音量スライダーには音量変更イベントがないため、
  // 定期的に実際のプレイヤー値を読み取り、アプリ側の状態へ反映する。
  const stopVolumeSync = useCallback(() => {
    if (volumeSyncTimerRef.current !== null) {
      window.clearInterval(volumeSyncTimerRef.current);
      volumeSyncTimerRef.current = null;
    }
  }, []);

  const startVolumeSync = useCallback((player: YT.Player) => {
    stopVolumeSync();
    volumeSyncTimerRef.current = window.setInterval(() => {
      if (ytPlayerRef.current !== player) return;
      try {
        const playerVolume = player.getVolume?.();
        if (typeof playerVolume !== 'number' || !Number.isFinite(playerVolume)) return;
        const nextVolume = Math.round(Math.max(0, Math.min(100, playerVolume)));
        if (usePlayerStore.getState().volume !== nextVolume) {
          setVolume(nextVolume);
        }
      } catch {
        // プレイヤー破棄と同時に呼ばれた場合は無視する。
      }
    }, 250);
  }, [setVolume, stopVolumeSync]);

  useEffect(() => {
    const ownership = getPlaybackOwnership();
    ownershipRef.current = ownership;
    const unsubscribe = ownership.onRemoteClaim(() => {
      const state = usePlayerStore.getState();
      if (state.isPlaying) state.pause();
    });
    const release = (event: PageTransitionEvent) => {
      // A bfcache transition is a temporary suspension, not ownership loss.
      if (!event.persisted) ownership.release();
    };
    const reclaim = () => {
      const state = usePlayerStore.getState();
      if (state.isPlaying && ownership.getState() !== 'remote') {
        ownership.claim(state.currentSong?.id ?? null);
      }
    };
    window.addEventListener('pagehide', release);
    window.addEventListener('pageshow', reclaim);
    return () => {
      unsubscribe();
      window.removeEventListener('pagehide', release);
      window.removeEventListener('pageshow', reclaim);
      ownership.release();
      ownershipRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (isPlaying) ownershipRef.current?.claim(currentSong?.id ?? null);
  }, [currentSong?.id, isPlaying]);

  // プログレス更新の定期実行
  const startProgressTimer = useCallback(() => {
    if (progressTimerRef.current) return;
    progressTimerRef.current = window.setInterval(() => {
      if (ytPlayerRef.current) {
        const currentTime = ytPlayerRef.current.getCurrentTime?.();
        if (typeof currentTime === 'number') {
          setProgress(currentTime);
        }
      }
    }, 500);
  }, [setProgress]);

  const stopProgressTimer = useCallback(() => {
    if (progressTimerRef.current) {
      clearInterval(progressTimerRef.current);
      progressTimerRef.current = null;
    }
  }, []);

  const clearEndRecoveryTimer = useCallback(() => {
    if (endRecoveryTimerRef.current !== null) {
      window.clearTimeout(endRecoveryTimerRef.current);
      endRecoveryTimerRef.current = null;
    }
  }, []);

  const advanceOnce = useCallback(() => {
    const activePV = usePlayerStore.getState().currentPV;
    if (!activePV) return;
    const key = `${activePV.service}:${activePV.pvId ?? activePV.id}`;
    if (advancedPVRef.current === key) return;
    advancedPVRef.current = key;
    clearEndRecoveryTimer();
    stopProgressTimer();
    usePlayerStore.getState().next();
  }, [clearEndRecoveryTimer, stopProgressTimer]);

  const scheduleEndRecovery = useCallback((player: YT.Player) => {
    clearEndRecoveryTimer();
    const needsPlaybackRestart = (playerState: number | undefined) => playerState === window.YT.PlayerState.PAUSED
      || playerState === window.YT.PlayerState.UNSTARTED
      || playerState === window.YT.PlayerState.CUED;
    const check = () => {
      endRecoveryTimerRef.current = null;
      if (ytPlayerRef.current !== player) return;
      try {
        const currentTime = player.getCurrentTime?.() ?? 0;
        const duration = player.getDuration?.() ?? 0;
        const playerState = player.getPlayerState?.();
        if (playerState === window.YT.PlayerState.ENDED || hasReachedPlaybackEnd(currentTime, duration)) {
          advanceOnce();
          return;
        }
        if (!usePlayerStore.getState().isPlaying) return;
        const playerNeedsRestart = needsPlaybackRestart(playerState);
        // Arm the next verification before calling playVideo. The mock API and
        // some browser versions may report PLAYING synchronously, whose state
        // callback replaces this timer without leaving an orphaned retry.
        endRecoveryTimerRef.current = window.setTimeout(
          check,
          getPlaybackRecoveryCheckDelayMs(playerNeedsRestart, currentTime, duration),
        );
        if (playerNeedsRestart) player.playVideo?.();
      } catch {
        // Player destruction can race with a scheduled check.
      }
    };
    let currentTime = 0;
    let duration = 0;
    let playerState: number | undefined;
    try {
      currentTime = player.getCurrentTime?.() ?? 0;
      duration = player.getDuration?.() ?? 0;
      playerState = player.getPlayerState?.();
    } catch {
      // Use the periodic fallback delay until the player is ready.
    }
    const playerNeedsRestart = needsPlaybackRestart(playerState);
    endRecoveryTimerRef.current = window.setTimeout(
      check,
      getPlaybackRecoveryCheckDelayMs(playerNeedsRestart, currentTime, duration),
    );
    if (playerNeedsRestart) player.playVideo?.();
  }, [advanceOnce, clearEndRecoveryTimer]);

  const failCurrentYouTubeAttempt = useCallback((message: string) => {
    const desired = youtubeDesiredVideoRef.current;
    const attemptController = attemptControllerRef.current;
    if (!desired || !attemptController.isCurrent(desired.attempt)) return;
    attemptController.cancel();
    youtubeDesiredVideoRef.current = null;
    stopProgressTimer();
    clearEndRecoveryTimer();
    try {
      ytPlayerRef.current?.stopVideo?.();
    } catch {
      // Keep the persistent iframe alive; the next PV can still be loaded into it.
    }
    setError(message);
    tryNextPV();
  }, [clearEndRecoveryTimer, setError, stopProgressTimer, tryNextPV]);

  const loadDesiredYouTubeVideo = useCallback((player: YT.Player) => {
    const desired = youtubeDesiredVideoRef.current;
    if (!desired || !youtubeReadyRef.current) return;
    if (!attemptControllerRef.current.isCurrent(desired.attempt)) return;
    const shouldPlay = usePlayerStore.getState().isPlaying;
    try {
      if (shouldPlay) {
        // Loading muted is allowed while the document is hidden. Reusing this
        // already-created player preserves the original user activation instead
        // of asking Chromium to authorize a brand-new background iframe.
        player.mute?.();
        youtubeAutoplayMutedRef.current = true;
        player.loadVideoById(desired.pvId, 0);
        player.playVideo?.();
        // Do not unmute until PLAYING. Unmuting during the asynchronous load can
        // make a browser re-evaluate autoplay and defer the start until visible.
        scheduleEndRecovery(player);
      } else {
        youtubeAutoplayMutedRef.current = false;
        player.cueVideoById(desired.pvId, 0);
      }
    } catch {
      failCurrentYouTubeAttempt('YouTube動画の準備に失敗しました');
    }
  }, [failCurrentYouTubeAttempt, scheduleEndRecovery]);

  const isYouTube = currentPV?.service === 'Youtube';
  const currentYouTubePVId = isYouTube ? currentPV.pvId : null;

  // Create one idle YouTube iframe for the lifetime of the app. GlobalPlayer is
  // mounted before a song is selected, so even the first track can reuse a
  // foreground-created iframe after the user switches to another tab/window.
  useEffect(() => {
    const attemptController = attemptControllerRef.current;
    const playerContainer = containerRef.current;
    if (!playerContainer) return;
    let disposed = false;
    let player: YT.Player | null = null;

    const initPlayer = async () => {
      try {
        await loadYouTubeAPI();
        if (disposed || !containerRef.current) return;

        const playerDiv = document.createElement('div');
        playerDiv.id = 'yt-player-embed';
        containerRef.current.innerHTML = '';
        containerRef.current.appendChild(playerDiv);

        player = new window.YT.Player('yt-player-embed', {
          width: '100%',
          height: '100%',
          playerVars: {
            autoplay: 0,
            controls: 1,
            origin: window.location.origin,
          },
          events: {
            onReady: (event: YT.PlayerEvent) => {
              if (disposed || ytPlayerRef.current !== event.target) return;
              youtubeReadyRef.current = true;
              event.target.setVolume(volumeRef.current);
              startVolumeSync(event.target);
              startProgressTimer();
              loadDesiredYouTubeVideo(event.target);
            },
            onStateChange: (event: YT.OnStateChangeEvent) => {
              const desired = youtubeDesiredVideoRef.current;
              if (!desired || !attemptControllerRef.current.isCurrent(desired.attempt)) return;
              switch (event.data) {
                case window.YT.PlayerState.PLAYING: {
                  attemptControllerRef.current.complete(desired.attempt);
                  const activePV = usePlayerStore.getState().currentPV;
                  if (activePV?.service === 'Youtube' && activePV.pvId === desired.pvId) {
                    markPVHealthy(activePV);
                  }
                  setIsPlaying(true);
                  if (youtubeAutoplayMutedRef.current && (!navigator.userActivation || navigator.userActivation.hasBeenActive)) {
                    event.target.unMute?.();
                    youtubeAutoplayMutedRef.current = false;
                  }
                  const dur = event.target.getDuration();
                  if (dur > 0) setDuration(dur);
                  startProgressTimer();
                  scheduleEndRecovery(event.target);
                  break;
                }
                case window.YT.PlayerState.PAUSED:
                  if (document.hidden && usePlayerStore.getState().isPlaying) {
                    event.target.playVideo?.();
                    scheduleEndRecovery(event.target);
                    break;
                  }
                  setIsPlaying(false);
                  stopProgressTimer();
                  clearEndRecoveryTimer();
                  break;
                case window.YT.PlayerState.ENDED:
                  advanceOnce();
                  break;
              }
            },
            onError: () => failCurrentYouTubeAttempt('YouTube動画の再生中にエラーが発生しました'),
          },
        });
        ytPlayerRef.current = player;
      } catch {
        if (!disposed) failCurrentYouTubeAttempt('YouTube動画の準備に失敗しました');
      }
    };

    void initPlayer();
    return () => {
      disposed = true;
      attemptController.cancel();
      youtubeDesiredVideoRef.current = null;
      youtubeReadyRef.current = false;
      stopVolumeSync();
      stopProgressTimer();
      clearEndRecoveryTimer();
      if (ytPlayerRef.current === player && player) {
        try {
          player.stopVideo?.();
          player.destroy();
        } finally {
          ytPlayerRef.current = null;
        }
      }
      if (playerContainer) playerContainer.innerHTML = '';
    };
  }, [advanceOnce, clearEndRecoveryTimer, failCurrentYouTubeAttempt, loadDesiredYouTubeVideo, markPVHealthy, scheduleEndRecovery, setDuration, setIsPlaying, startProgressTimer, stopProgressTimer, startVolumeSync, stopVolumeSync]);

  // The persistent YouTube iframe remains mounted while another service is in
  // use, but its previous video must not keep playing underneath that service.
  useEffect(() => {
    if (isYouTube || !ytPlayerRef.current) return;
    try {
      ytPlayerRef.current.stopVideo?.();
    } catch {
      // The idle player may still be completing its initial setup.
    }
  }, [isYouTube]);

  // Switch videos inside the persistent player. playbackSequence is included so
  // replaying the same PV restarts it without recreating the iframe.
  useEffect(() => {
    if (!currentYouTubePVId) return;
    const attemptController = attemptControllerRef.current;
    attemptController.cancel();
    advancedPVRef.current = null;
    clearEndRecoveryTimer();
    stopProgressTimer();
    setProgress(0);
    if (currentSong?.lengthSeconds) setDuration(currentSong.lengthSeconds);

    const pvId = currentYouTubePVId;
    const armAttempt = (): PlaybackAttemptToken => {
      const token = attemptController.start(pvId, () => {
        const desired = youtubeDesiredVideoRef.current;
        if (!desired || desired.attempt !== token) return;
        if (document.hidden && usePlayerStore.getState().isPlaying) {
          // A hidden page may delay iframe/API readiness even though the PV is
          // healthy. Keep the preferred YouTube PV selected and retry muted;
          // only an explicit YT error or a visible timeout may fail it over.
          try {
            ytPlayerRef.current?.mute?.();
            youtubeAutoplayMutedRef.current = true;
            ytPlayerRef.current?.playVideo?.();
            if (ytPlayerRef.current) scheduleEndRecovery(ytPlayerRef.current);
          } catch {
            // The next bounded attempt will retry after iframe readiness.
          }
          desired.attempt = armAttempt();
          return;
        }
        failCurrentYouTubeAttempt('YouTube動画の準備がタイムアウトしました');
      });
      return token;
    };
    const attempt = armAttempt();
    youtubeDesiredVideoRef.current = {
      pvId,
      songId: currentSong?.id ?? null,
      playbackSequence,
      attempt,
    };
    const player = ytPlayerRef.current;
    if (player && youtubeReadyRef.current) loadDesiredYouTubeVideo(player);

    return () => {
      if (youtubeDesiredVideoRef.current?.attempt !== attempt) return;
      attemptController.cancel();
      youtubeDesiredVideoRef.current = null;
    };
  }, [clearEndRecoveryTimer, currentSong?.id, currentSong?.lengthSeconds, currentYouTubePVId, failCurrentYouTubeAttempt, loadDesiredYouTubeVideo, playbackSequence, scheduleEndRecovery, setDuration, setProgress, stopProgressTimer]);

  // Muted autoplay is the browser-safe way to get a newly selected song
  // moving in a background tab. If the session had no activation yet, restore
  // audio on the first later gesture instead of leaving successful playback
  // silently muted forever.
  useEffect(() => {
    const restoreAutoplayAudio = () => {
      const player = ytPlayerRef.current;
      if (!player || !youtubeAutoplayMutedRef.current || !usePlayerStore.getState().isPlaying) return;
      try {
        player.unMute?.();
        player.setVolume?.(volumeRef.current);
        youtubeAutoplayMutedRef.current = false;
      } catch {
        // The player may be replaced during navigation.
      }
    };
    window.addEventListener('pointerdown', restoreAutoplayAudio, { capture: true });
    window.addEventListener('keydown', restoreAutoplayAudio, { capture: true });
    return () => {
      window.removeEventListener('pointerdown', restoreAutoplayAudio, { capture: true });
      window.removeEventListener('keydown', restoreAutoplayAudio, { capture: true });
    };
  }, []);

  const recoverYouTubePlayback = useCallback(() => {
    const player = ytPlayerRef.current;
    const state = usePlayerStore.getState();
    if (!player || currentPV?.service !== 'Youtube' || !state.isPlaying) return;
    if (ownershipRef.current?.getState() !== 'local') return;
    try {
      const currentTime = player.getCurrentTime?.() ?? 0;
      const duration = player.getDuration?.() ?? useProgressStore.getState().duration;
      const playerState = player.getPlayerState?.();
      if (playerState === window.YT.PlayerState.ENDED || hasReachedPlaybackEnd(currentTime, duration)) {
        advanceOnce();
        return;
      }
      const rememberedProgress = useProgressStore.getState().progress;
      const safePosition = getSafeWakePosition(currentTime, rememberedProgress, duration);
      if (safePosition > currentTime + 1) {
        player.seekTo?.(safePosition, true);
        setProgress(safePosition);
      }
      const playerNeedsRestart = playerState === window.YT.PlayerState.PAUSED
        || playerState === window.YT.PlayerState.UNSTARTED
        || playerState === window.YT.PlayerState.CUED;
      if (playerNeedsRestart) player.playVideo?.();
      scheduleEndRecovery(player);
    } catch {
      // The iframe may be between player generations.
    }
  }, [advanceOnce, currentPV, scheduleEndRecovery, setProgress]);
  usePlaybackWakeRecovery(recoverYouTubePlayback, currentPV?.service === 'Youtube');

  // 再生/一時停止の同期
  useEffect(() => {
    if (!ytPlayerRef.current || !currentPV || currentPV.service !== 'Youtube') return;
    
    try {
      if (isPlaying) {
        ytPlayerRef.current.playVideo?.();
      } else {
        ytPlayerRef.current.pauseVideo?.();
      }
    } catch {
      // プレイヤーが準備できていない場合は無視
    }
  }, [isPlaying, currentPV]);

  // ボリューム同期
  useEffect(() => {
    if (!ytPlayerRef.current || !currentPV || currentPV.service !== 'Youtube') return;
    try {
      ytPlayerRef.current.setVolume?.(volume);
    } catch {
      // ignore
    }
  }, [volume, currentPV]);

  // シーク: seekTarget が設定されたらシーク実行してクリア
  useEffect(() => {
    if (seekTarget === null || !ytPlayerRef.current || !currentPV || currentPV.service !== 'Youtube') return;
    try {
      ytPlayerRef.current.seekTo?.(seekTarget, true);
      setProgress(seekTarget);
    } catch {
      // ignore
    }
    clearSeekTarget();
  }, [seekTarget, clearSeekTarget, currentPV, setProgress]);

  return (
    <>
      <div ref={containerRef} className={`w-full h-full${currentPV && !isYouTube ? ' hidden' : ''}`} aria-hidden={currentPV ? !isYouTube : true}>
        <div id="yt-player-embed" />
      </div>
      {currentPV?.service === 'NicoNicoDouga' && (
        <NicoEmbed key={`${currentPV.pvId}:${playbackSequence}`} pvId={currentPV.pvId} name={currentPV.name} duration={currentSong?.lengthSeconds} isPlaying={isPlaying} />
      )}
      {currentPV?.service === 'SoundCloud' && (
        <SoundCloudEmbed key={`${currentPV.pvId}:${playbackSequence}`} pv={currentPV} isPlaying={isPlaying} />
      )}
      {currentPV?.service === 'Bilibili' && (
        <BilibiliEmbed key={`${currentPV.pvId}:${playbackSequence}`} pv={currentPV} isPlaying={isPlaying} duration={currentSong?.lengthSeconds} />
      )}
    </>
  );
}
