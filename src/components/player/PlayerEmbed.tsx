import { useEffect, useRef, useCallback } from 'react';
import { usePlayerStore } from '../../stores/playerStore';

/**
 * PlayerEmbed - YouTube / ニコニコ動画の埋め込みプレイヤー
 *
 * 選択されたPVのサービスに応じて適切なiframeを表示。
 * YouTube: IFrame Player API を使用して再生制御。
 * ニコニコ: postMessage API を使用。
 */

// YouTube IFrame API の型
declare global {
  interface Window {
    YT: typeof YT;
    onYouTubeIframeAPIReady: () => void;
  }
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
  const { currentPV, isPlaying, volume, progress, setProgress, setDuration, setIsPlaying, setError, next } = usePlayerStore();
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
          controls: 0,
          disablekb: 1,
          modestbranding: 1,
          rel: 0,
          showinfo: 0,
          origin: window.location.origin,
        },
        events: {
          onReady: (event: YT.PlayerEvent) => {
            event.target.setVolume(volume);
            setDuration(event.target.getDuration());
            startProgressTimer();
          },
          onStateChange: (event: YT.OnStateChangeEvent) => {
            switch (event.data) {
              case window.YT.PlayerState.PLAYING:
                setIsPlaying(true);
                startProgressTimer();
                break;
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
            // 自動スキップ
            setTimeout(() => next(), 1000);
          },
        },
      });
    };

    initPlayer();

    return () => {
      stopProgressTimer();
    };
  }, [currentPV, volume, setDuration, setIsPlaying, setError, next, startProgressTimer, stopProgressTimer]);

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
    const nicoUrl = `https://embed.nicovideo.jp/watch/${currentPV.pvId}?autoplay=1&mute=0`;
    return (
      <div className="w-full h-full">
        <iframe
          src={nicoUrl}
          className="w-full h-full border-0"
          allow="autoplay; fullscreen"
          allowFullScreen
          title={currentPV.name || 'ニコニコ動画プレイヤー'}
          style={{ pointerEvents: 'none' }}
        />
      </div>
    );
  }

  // YouTube プレイヤーコンテナ
  return (
    <div ref={containerRef} className="w-full h-full">
      <div id="yt-player-embed" />
    </div>
  );
}
