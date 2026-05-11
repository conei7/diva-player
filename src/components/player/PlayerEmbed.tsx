/// <reference types="@types/youtube" />
import { useEffect, useRef, useCallback } from 'react';
import { usePlayerStore } from '../../stores/playerStore';

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
function NicoEmbed({ pvId, name, duration: songDuration }: { pvId: string; name?: string; duration?: number }) {
  const { volume, setProgress, setDuration, setIsPlaying, next } = usePlayerStore();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const embedUrl = `https://embed.nicovideo.jp/watch/${pvId}?autoplay=1&allowProgrammaticFullscreen=1`;
  const NICO_ORIGIN = 'https://embed.nicovideo.jp';

  const timerRef = useRef<number | null>(null);
  const playStartRef = useRef<number | null>(null);
  const baseProgressRef = useRef<number>(0);
  const isActuallyPlayingRef = useRef(false);

  const stopTimer = useCallback(() => {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    playStartRef.current = null;
  }, []);

  const startTimer = useCallback(() => {
    stopTimer();
    playStartRef.current = Date.now();
    timerRef.current = window.setInterval(() => {
      if (playStartRef.current !== null) {
        const elapsed = (Date.now() - playStartRef.current) / 1000;
        setProgress(baseProgressRef.current + elapsed);
      }
    }, 500);
  }, [setProgress, stopTimer]);

  // マウント時: ニコニコはautoplayしないので一時停止状態にリセット
  useEffect(() => {
    setIsPlaying(false);
    setProgress(0);
    baseProgressRef.current = 0;
    if (songDuration && songDuration > 0) setDuration(songDuration);
    return () => stopTimer();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pvId]);

  // iframeロード後にニコニコへ再生コマンドを送信し、タイマーも開始
  const handleIframeLoad = useCallback(() => {
    if (songDuration && songDuration > 0) setDuration(songDuration);
    setTimeout(() => {
      iframeRef.current?.contentWindow?.postMessage(
        JSON.stringify({ eventName: 'player:play' }),
        NICO_ORIGIN,
      );
    }, 1000);
  }, [setDuration, songDuration]);

  // ニコニコからのpostMessageを受信
  useEffect(() => {
    const handler = (e: MessageEvent) => {
      // embed.nicovideo.jp か www.nicovideo.jp からのメッセージのみ処理
      if (!e.origin.includes('nicovideo.jp')) return;
      let msg: { eventName?: string; data?: Record<string, unknown> };
      try {
        msg = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
      } catch {
        return;
      }
      if (!msg.eventName) return;
      switch (msg.eventName) {
        // === 新API (player: prefix) ===
        case 'player:loadComplete':
        // === 旧API ===
        case 'loadComplete': {
          const len = (msg.data?.videoInfo as { lengthInSeconds?: number } | undefined)?.lengthInSeconds;
          if (typeof len === 'number' && len > 0) setDuration(len);
          break;
        }
        case 'player:currentTime': {
          // 新API: currentTime は秒単位
          const t = (msg.data as { currentTime?: number } | undefined)?.currentTime;
          if (typeof t === 'number') {
            baseProgressRef.current = t;
            playStartRef.current = Date.now();
            setProgress(t);
          }
          break;
        }
        case 'seekStatusChange': {
          // 旧API: currentTime はミリ秒単位
          const ms = (msg.data as { currentTime?: number } | undefined)?.currentTime;
          if (typeof ms === 'number') {
            const secs = ms / 1000;
            baseProgressRef.current = secs;
            playStartRef.current = Date.now();
            setProgress(secs);
          }
          break;
        }
        case 'player:play':
          isActuallyPlayingRef.current = true;
          setIsPlaying(true);
          startTimer();
          break;
        case 'playerStatusChange': {
          // 旧API: playerStatus 3=playing, 4=paused, 5=ended
          const status = (msg.data as { playerStatus?: number } | undefined)?.playerStatus;
          if (status === 3) {
            isActuallyPlayingRef.current = true;
            setIsPlaying(true);
            startTimer();
          } else if (status === 4) {
            isActuallyPlayingRef.current = false;
            setIsPlaying(false);
            if (playStartRef.current !== null) {
              baseProgressRef.current += (Date.now() - playStartRef.current) / 1000;
            }
            stopTimer();
          } else if (status === 5) {
            isActuallyPlayingRef.current = false;
            stopTimer();
            next();
          }
          break;
        }
        case 'player:pause':
          isActuallyPlayingRef.current = false;
          setIsPlaying(false);
          if (playStartRef.current !== null) {
            baseProgressRef.current += (Date.now() - playStartRef.current) / 1000;
          }
          stopTimer();
          break;
        case 'player:ended':
          isActuallyPlayingRef.current = false;
          stopTimer();
          next();
          break;
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [setProgress, setDuration, setIsPlaying, next, startTimer, stopTimer]);

  // ボリューム同期
  useEffect(() => {
    iframeRef.current?.contentWindow?.postMessage(
      JSON.stringify({ eventName: 'player:volume', data: { volume: volume / 100 } }),
      NICO_ORIGIN,
    );
  }, [volume]);

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
  const { currentSong, currentPV, isPlaying, volume, progress, setProgress, setDuration, setIsPlaying, setError, next, tryNextPV } = usePlayerStore();
  const ytPlayerRef = useRef<YT.Player | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const progressTimerRef = useRef<number | null>(null);
  const lastPVIdRef = useRef<string | null>(null);
  const seekingRef = useRef(false);

  // プログレス更新の定期実行
  const startProgressTimer = useCallback(() => {
    if (progressTimerRef.current) return;
    progressTimerRef.current = window.setInterval(() => {
      if (ytPlayerRef.current && !seekingRef.current) {
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
    if (!currentPV || currentPV.service !== 'Youtube') {
      // YouTube以外の場合、YTプレイヤーをクリーンアップ
      if (ytPlayerRef.current) {
        ytPlayerRef.current.destroy();
        ytPlayerRef.current = null;
      }
      stopProgressTimer();
      return;
    }

    const pvId = currentPV.pvId;
    if (lastPVIdRef.current === pvId) return;
    lastPVIdRef.current = pvId;

    const initPlayer = async () => {
      await loadYouTubeAPI();
      
      // 既存プレイヤーの破棄
      if (ytPlayerRef.current) {
        ytPlayerRef.current.destroy();
        ytPlayerRef.current = null;
      }

      if (!containerRef.current) return;

      // div要素を再作成（YT APIが要素を置き換えるため）
      const playerDiv = document.createElement('div');
      playerDiv.id = 'yt-player-embed';
      containerRef.current.innerHTML = '';
      containerRef.current.appendChild(playerDiv);

      ytPlayerRef.current = new window.YT.Player('yt-player-embed', {
        videoId: pvId,
        width: '100%',
        height: '100%',
        playerVars: {
          autoplay: 1,
          // mute: 1 でミュート自動再生を許可し、onReady でアンミュートする。
          // これにより Chrome の Autoplay Policy (クロスオリジン iframe 制限) を回避できる。
          mute: 1,
          controls: 1,
          origin: window.location.origin,
        },
        events: {
          onReady: (event: YT.PlayerEvent) => {
            // ミュート解除して指定ボリュームを設定してから再生開始
            event.target.unMute();
            event.target.setVolume(volume);
            event.target.playVideo();
            const dur = event.target.getDuration();
            if (dur > 0) setDuration(dur);
            startProgressTimer();
          },
          onStateChange: (event: YT.OnStateChangeEvent) => {
            switch (event.data) {
              case window.YT.PlayerState.PLAYING: {
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
          onError: () => {
            setError('YouTube動画の再生中にエラーが発生しました');
            stopProgressTimer();
            // YouTube再生失敗時: 同じ曲の次のPV（NicoNico等）を試みる
            setTimeout(() => tryNextPV(), 1000);
          },
        },
      });
    };

    initPlayer();

    return () => {
      stopProgressTimer();
    };
  }, [currentPV, volume, setDuration, setIsPlaying, setError, next, tryNextPV, startProgressTimer, stopProgressTimer]);

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

  // シーク同期（ユーザーがプログレスバーをクリックした場合）
  useEffect(() => {
    if (!ytPlayerRef.current || !currentPV || currentPV.service !== 'Youtube') return;
    // プログレスの外部変更を検知（大きなジャンプ = ユーザーシーク）
    const handleSeek = () => {
      try {
        const currentTime = ytPlayerRef.current?.getCurrentTime?.() ?? 0;
        if (Math.abs(progress - currentTime) > 2) {
          seekingRef.current = true;
          ytPlayerRef.current?.seekTo?.(progress, true);
          setTimeout(() => { seekingRef.current = false; }, 500);
        }
      } catch {
        // ignore
      }
    };
    handleSeek();
  }, [progress, currentPV]);

  // ニコニコ動画の埋め込み
  if (currentPV?.service === 'NicoNicoDouga') {
    return <NicoEmbed pvId={currentPV.pvId} name={currentPV.name} duration={currentSong?.lengthSeconds} />;
  }

  // YouTube プレイヤーコンテナ
  return (
    <div ref={containerRef} className="w-full h-full">
      <div id="yt-player-embed" />
    </div>
  );
}
