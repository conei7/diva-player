/// <reference types="@types/youtube" />
import { useEffect, useRef, useCallback } from 'react';
import { usePlayerStore } from '../../stores/playerStore';
import { useProgressStore } from '../../stores/progressStore';
import { createPlaybackOwnership } from '../../services/playbackOwnership';
import { createPlaybackAttemptController } from '../../services/playbackAttempt';
import { createNicoProgressTracker, createNicoVolumeMessage, parseNicoPlayerMessage } from '../../services/nicoPlayerSync';

/**
 * PlayerEmbed - YouTube / ニコニコ動画の埋め込みプレイヤー
 *
 * 選択されたPVのサービスに応じて適切なiframeを表示。
 * YouTube: IFrame Player API を使用して再生制御。
 * ニコニコ: iframe埋め込み制限のため「ニコニコで開く」UIを表示。
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
  const { volume, setIsPlaying, next } = usePlayerStore();
  const setProgress = useProgressStore(s => s.setProgress);
  const setDuration = useProgressStore(s => s.setDuration);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const embedUrl = `https://embed.nicovideo.jp/watch/${pvId}?autoplay=1&allowProgrammaticFullscreen=1`;
  const NICO_ORIGIN = 'https://embed.nicovideo.jp';

  const timerRef = useRef<number | null>(null);
  const volumeRetryRef = useRef<number | null>(null);
  const playTimerRef = useRef<number | null>(null);
  const trackerRef = useRef(createNicoProgressTracker());

  const sendVolume = useCallback(() => {
    iframeRef.current?.contentWindow?.postMessage(
      createNicoVolumeMessage(volume),
      NICO_ORIGIN,
    );
  }, [volume]);

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

  const startTimer = useCallback(() => {
    stopTimer();
    trackerRef.current.setPlaying(true);
    timerRef.current = window.setInterval(() => {
      setProgress(trackerRef.current.current());
    }, 500);
  }, [setProgress, stopTimer]);

  // マウント時: ニコニコはautoplayしないので一時停止状態にリセット
  useEffect(() => {
    setProgress(0);
    trackerRef.current.reset();
    trackerRef.current.setDuration(songDuration);
    if (songDuration && songDuration > 0) setDuration(songDuration);
    return () => {
      stopTimer();
      if (volumeRetryRef.current !== null) window.clearTimeout(volumeRetryRef.current);
      if (playTimerRef.current !== null) window.clearTimeout(playTimerRef.current);
      volumeRetryRef.current = null;
      playTimerRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pvId]);

  // iframeロード後にニコニコへ再生コマンドを送信し、タイマーも開始
  const handleIframeLoad = useCallback(() => {
    if (songDuration && songDuration > 0) setDuration(songDuration);
    scheduleVolumeSync();
    if (playTimerRef.current !== null) window.clearTimeout(playTimerRef.current);
    playTimerRef.current = window.setTimeout(() => {
      playTimerRef.current = null;
      if (!isPlaying) return;
      iframeRef.current?.contentWindow?.postMessage(
        JSON.stringify({ eventName: 'player:play' }),
        NICO_ORIGIN,
      );
    }, 1000);
  }, [isPlaying, scheduleVolumeSync, setDuration, songDuration]);

  useEffect(() => {
    iframeRef.current?.contentWindow?.postMessage(
      JSON.stringify({ eventName: isPlaying ? 'player:play' : 'player:pause' }),
      NICO_ORIGIN,
    );
  }, [isPlaying]);

  // ニコニコからのpostMessageを受信
  useEffect(() => {
    const handler = (e: MessageEvent) => {
      // embed.nicovideo.jp か www.nicovideo.jp からのメッセージのみ処理
      if (!e.origin.includes('nicovideo.jp')) return;
      const message = parseNicoPlayerMessage(e.data);
      if (!message) return;
      switch (message.type) {
        case 'ready': {
          if (message.duration) {
            trackerRef.current.setDuration(message.duration);
            setDuration(message.duration);
          }
          break;
        }
        case 'progress': {
          trackerRef.current.confirm(message.seconds);
          setProgress(trackerRef.current.current());
          break;
        }
        case 'playing':
          setIsPlaying(true);
          startTimer();
          break;
        case 'paused':
          trackerRef.current.setPlaying(false);
          setProgress(trackerRef.current.current());
          setIsPlaying(false);
          stopTimer();
          break;
        case 'ended':
          trackerRef.current.setPlaying(false);
          stopTimer();
          next();
          break;
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [setProgress, setDuration, setIsPlaying, next, startTimer, stopTimer]);

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
  const { currentSong, currentPV, isPlaying, volume, seekTarget, clearSeekTarget, setIsPlaying, setError, next, tryNextPV } = usePlayerStore();
  const setProgress = useProgressStore(s => s.setProgress);
  const setDuration = useProgressStore(s => s.setDuration);
  const ytPlayerRef = useRef<YT.Player | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const progressTimerRef = useRef<number | null>(null);
  const attemptControllerRef = useRef(createPlaybackAttemptController());
  const volumeRef = useRef(volume);
  const ownershipRef = useRef<ReturnType<typeof createPlaybackOwnership> | null>(null);

  useEffect(() => {
    volumeRef.current = volume;
  }, [volume]);

  useEffect(() => {
    const ownership = createPlaybackOwnership();
    ownershipRef.current = ownership;
    const unsubscribe = ownership.onRemoteClaim(() => {
      const state = usePlayerStore.getState();
      if (state.isPlaying) state.pause();
    });
    const release = () => ownership.release();
    window.addEventListener('pagehide', release);
    return () => {
      unsubscribe();
      window.removeEventListener('pagehide', release);
      ownership.release();
      ownership.destroy();
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

  // YouTube プレイヤー初期化/更新
  useEffect(() => {
    const attemptController = attemptControllerRef.current;
    const playerContainer = containerRef.current;
    attemptController.cancel();

    if (!currentPV || currentPV.service !== 'Youtube') {
      // YouTube以外の場合、YTプレイヤーをクリーンアップ
      if (ytPlayerRef.current) {
        ytPlayerRef.current.destroy();
        ytPlayerRef.current = null;
      }
      if (playerContainer) playerContainer.innerHTML = '';
      stopProgressTimer();
      return;
    }

    const pvId = currentPV.pvId;
    let player: YT.Player | null = null;
    const attempt = attemptController.start(pvId, () => {
      handleFailure('YouTube動画の準備がタイムアウトしました');
    });

    const handleFailure = (message: string) => {
      if (!attemptController.isCurrent(attempt)) return;
      attemptController.cancel();
      stopProgressTimer();
      if (ytPlayerRef.current === player && ytPlayerRef.current) {
        ytPlayerRef.current.stopVideo?.();
        ytPlayerRef.current.destroy();
        ytPlayerRef.current = null;
      }
      if (containerRef.current) containerRef.current.innerHTML = '';
      setIsPlaying(false);
      setError(message);
      tryNextPV();
    };

    const initPlayer = async () => {
      try {
        await loadYouTubeAPI();
        if (!attemptController.isCurrent(attempt) || !playerContainer) return;

        // div要素を再作成（YT APIが要素を置き換えるため）
        const playerDiv = document.createElement('div');
        playerDiv.id = 'yt-player-embed';
        playerContainer.innerHTML = '';
        playerContainer.appendChild(playerDiv);

        player = new window.YT.Player('yt-player-embed', {
          videoId: pvId,
          width: '100%',
          height: '100%',
          playerVars: {
            autoplay: 1,
            // mute: 1 でミュート自動再生を許可し、onReady でアンミュートする。
            mute: 1,
            controls: 1,
            origin: window.location.origin,
          },
          events: {
            onReady: (event: YT.PlayerEvent) => {
              if (!attemptController.isCurrent(attempt)) return;
              attemptController.complete(attempt);
              event.target.unMute();
              event.target.setVolume(volumeRef.current);
              if (usePlayerStore.getState().isPlaying) event.target.playVideo();
              const dur = event.target.getDuration();
              if (dur > 0) setDuration(dur);
              startProgressTimer();
            },
            onStateChange: (event: YT.OnStateChangeEvent) => {
              if (!attemptController.isCurrent(attempt)) return;
              switch (event.data) {
                case window.YT.PlayerState.PLAYING: {
                  attemptController.complete(attempt);
                  setIsPlaying(true);
                  const dur = event.target.getDuration();
                  if (dur > 0) setDuration(dur);
                  startProgressTimer();
                  break;
                }
                case window.YT.PlayerState.PAUSED:
                  setIsPlaying(false);
                  stopProgressTimer();
                  break;
                case window.YT.PlayerState.ENDED:
                  stopProgressTimer();
                  next();
                  break;
              }
            },
            onError: () => handleFailure('YouTube動画の再生中にエラーが発生しました'),
          },
        });
        ytPlayerRef.current = player;
      } catch {
        handleFailure('YouTube動画の準備に失敗しました');
      }
    };

    void initPlayer();

    return () => {
      attemptController.cancel();
      stopProgressTimer();
      if (ytPlayerRef.current === player && ytPlayerRef.current) {
        ytPlayerRef.current.stopVideo?.();
        ytPlayerRef.current.destroy();
        ytPlayerRef.current = null;
      }
      if (playerContainer) playerContainer.innerHTML = '';
    };
  }, [currentPV, currentSong?.id, setDuration, setIsPlaying, setError, next, tryNextPV, startProgressTimer, stopProgressTimer]);

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

  // ニコニコ動画の埋め込み
  if (currentPV?.service === 'NicoNicoDouga') {
    return <NicoEmbed key={currentPV.pvId} pvId={currentPV.pvId} name={currentPV.name} duration={currentSong?.lengthSeconds} isPlaying={isPlaying} />;
  }

  // YouTube プレイヤーコンテナ
  return (
    <div ref={containerRef} className="w-full h-full">
      <div id="yt-player-embed" />
    </div>
  );
}
