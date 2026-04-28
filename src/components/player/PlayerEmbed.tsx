/// <reference types="@types/youtube" />
import { useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
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
 * NicoNico の iframe 埋め込みは現在制限されているため、
 * createPortal でプレイヤーバー上部に「NicoNicoで開く」UIを表示する。
 * 一定時間後に自動で次の曲へスキップする。
 */
function NicoEmbed({ pvId, name }: { pvId: string; name?: string }) {
  const { next } = usePlayerStore();

  // 10秒後に自動スキップ
  useEffect(() => {
    const timer = setTimeout(() => next(), 10000);
    return () => clearTimeout(timer);
  }, [pvId, next]);

  const nicoUrl = `https://www.nicovideo.jp/watch/${pvId}`;

  const miniPlayer = createPortal(
    <div
      style={{
        position: 'fixed',
        bottom: 'calc(var(--player-bar-height) + 8px)',
        left: '16px',
        width: '320px',
        zIndex: 49,
        borderRadius: '8px',
        overflow: 'hidden',
        boxShadow: '0 4px 16px rgba(0,0,0,0.7)',
        background: '#1a1a1a',
        padding: '20px',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: '12px',
        color: 'white',
      }}
    >
      {/* NicoNico ロゴ色のアイコン */}
      <svg width="40" height="40" viewBox="0 0 24 24" fill="#e6002d">
        <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 14.5v-9l6 4.5-6 4.5z"/>
      </svg>
      <p style={{ margin: 0, fontSize: '13px', textAlign: 'center', opacity: 0.9 }}>
        {name || pvId}
      </p>
      <p style={{ margin: 0, fontSize: '11px', opacity: 0.6, textAlign: 'center' }}>
        ニコニコ動画はiframe埋め込みに対応していません。
        <br />10秒後に自動スキップします。
      </p>
      <div style={{ display: 'flex', gap: '8px' }}>
        <a
          href={nicoUrl}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            padding: '8px 16px',
            background: '#e6002d',
            color: 'white',
            borderRadius: '4px',
            textDecoration: 'none',
            fontSize: '13px',
            fontWeight: 600,
          }}
        >
          ニコニコで開く
        </a>
        <button
          onClick={() => next()}
          style={{
            padding: '8px 16px',
            background: '#333',
            color: 'white',
            borderRadius: '4px',
            border: 'none',
            cursor: 'pointer',
            fontSize: '13px',
          }}
        >
          スキップ
        </button>
      </div>
    </div>,
    document.body,
  );

  return (
    <>
      {miniPlayer}
      {/* 64x64 サムネイルスロット */}
      <div className="w-full h-full flex items-center justify-center" style={{ background: '#1a0005' }}>
        <svg width="28" height="28" viewBox="0 0 24 24" fill="#e6002d">
          <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 14.5v-9l6 4.5-6 4.5z"/>
        </svg>
      </div>
    </>
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
  const { currentPV, isPlaying, volume, progress, setProgress, setDuration, setIsPlaying, setError, next, tryNextPV } = usePlayerStore();
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
          controls: 0,
          disablekb: 1,
          modestbranding: 1,
          rel: 0,
          showinfo: 0,
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
    return <NicoEmbed pvId={currentPV.pvId} name={currentPV.name} />;
  }

  // YouTube プレイヤーコンテナ
  return (
    <div ref={containerRef} className="w-full h-full">
      <div id="yt-player-embed" />
    </div>
  );
}
