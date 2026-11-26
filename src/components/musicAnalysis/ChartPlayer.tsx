import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { useTranslateSourceText } from '../../i18n';
import { activeSegment, chartTime, chordName, DEGREES, keyAt, NOTE_NAMES, pitchClass, videoTime, type Chart } from '../../musicAnalysis/chart';
import { demoWav, MAX_FILE_BYTES } from '../../musicAnalysis/localAudio';
import { loadYouTubeAPI } from '../../services/youtubeIframeApi';
import { usePlayerStore } from '../../stores/playerStore';
import { formatClockDuration } from '../../utils/songMeta';
import { cx } from '../ui/overlay';

export interface ChartJump {
  start: number;
}

export default function ChartPlayer({ chart, file, jump, onAttach }: {
  chart: Chart;
  file?: File;
  jump: ChartJump;
  onAttach: (file: File) => void;
}) {
  const t = useTranslateSourceText();
  const audio = useRef<HTMLAudioElement>(null);
  const videoHost = useRef<HTMLDivElement>(null);
  const video = useRef<YT.Player | null>(null);
  const [videoReady, setVideoReady] = useState(false);
  const [mediaError, setMediaError] = useState(false);
  const [attachmentError, setAttachmentError] = useState('');
  const [time, setTime] = useState(-1);
  const [localJump, setLocalJump] = useState<{ request: ChartJump; start: number } | null>(null);
  const [retry, setRetry] = useState(0);
  const rail = useRef<HTMLDivElement>(null);
  const activeButton = useRef<HTMLButtonElement>(null);
  const active = activeSegment(chart.chords, time);
  const segment = chart.chords[active];
  const target = localJump?.request === jump ? localJump.start : jump.start;
  const videoId = chart.videoId;
  const key = keyAt(chart, time);

  useEffect(() => {
    const element = audio.current;
    const source = file ?? (chart.id === 'demo' ? demoWav() : null);
    if (!element || !source) return;
    const url = URL.createObjectURL(source);
    element.src = url;
    return () => {
      element.pause();
      element.removeAttribute('src');
      element.load();
      URL.revokeObjectURL(url);
    };
  }, [chart.id, file]);

  useEffect(() => {
    const host = videoHost.current;
    if (!videoId || !host) return;
    let player: YT.Player | undefined;
    let disposed = false;
    let readyTimeout = 0;
    function onFailure() {
      if (!disposed) {
        setMediaError(true);
        setVideoReady(false);
      }
    }
    loadYouTubeAPI().then(() => {
      if (disposed) return;
      const placeholder = document.createElement('div');
      host.append(placeholder);
      readyTimeout = window.setTimeout(onFailure, 15000);
      player = new window.YT.Player(placeholder, {
        videoId,
        width: '100%',
        height: '100%',
        playerVars: { autoplay: 0, origin: window.location.origin, playsinline: 1 },
        events: {
          onReady: (event) => {
            if (disposed) return;
            clearTimeout(readyTimeout);
            event.target.getIframe().title = chart.title;
            video.current = event.target;
            setVideoReady(true);
            setMediaError(false);
          },
          onError: onFailure,
          onStateChange: ({ data }) => {
            if (!disposed && data === window.YT.PlayerState.PLAYING) usePlayerStore.getState().pause();
          },
        },
      });
    }).catch(onFailure);
    return () => {
      disposed = true;
      clearTimeout(readyTimeout);
      video.current = null;
      player?.destroy();
      host.replaceChildren();
    };
  }, [chart.title, retry, videoId]);

  useEffect(() => {
    if (!videoReady) return;
    const timer = window.setInterval(() => {
      const seconds = video.current?.getCurrentTime();
      if (typeof seconds === 'number' && Number.isFinite(seconds)) setTime(chartTime(chart, seconds));
    }, 100);
    return () => clearInterval(timer);
  }, [chart, videoReady]);

  useEffect(() => usePlayerStore.subscribe((state, previous) => {
    if (!state.isPlaying || previous.isPlaying) return;
    audio.current?.pause();
    video.current?.pauseVideo();
  }), []);

  useEffect(() => {
    const element = audio.current;
    function seekAudio() {
      if (element && element.readyState) element.currentTime = target;
    }
    seekAudio();
    element?.addEventListener('loadedmetadata', seekAudio);
    return () => element?.removeEventListener('loadedmetadata', seekAudio);
  }, [file, jump, localJump, target]);

  useEffect(() => {
    const player = video.current;
    if (!videoReady || !player || !videoId) return;
    const seconds = Math.max(0, videoTime(chart, target));
    const state = player.getPlayerState();
    if (state === window.YT.PlayerState.UNSTARTED || state === window.YT.PlayerState.CUED) {
      if (seconds > 0 || player.getCurrentTime() > 0) player.cueVideoById({ videoId, startSeconds: seconds });
    } else {
      player.seekTo(seconds, true);
    }
  }, [chart, jump, localJump, target, videoId, videoReady]);

  useEffect(() => {
    const container = rail.current;
    const button = activeButton.current;
    if (!container || !button) return;
    if (button.offsetLeft < container.scrollLeft || button.offsetLeft + button.offsetWidth > container.scrollLeft + container.clientWidth) {
      container.scrollTo({ left: button.offsetLeft - container.clientWidth / 3, behavior: 'instant' });
    }
  }, [active]);

  const canJump = videoReady || Boolean(file) || chart.id === 'demo';
  const next = active >= 0 ? chart.chords[active + 1] : chart.chords.find(item => item.start > time);

  async function attachAudio(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const original = input.files?.[0];
    setAttachmentError('');
    if (!original) return;
    if (!original.size || original.size > MAX_FILE_BYTES) {
      setAttachmentError('40 MB以下の音源ファイルを選んでください。');
      return;
    }
    if (chart.audioSha256 && crypto.subtle) {
      try {
        const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', await original.arrayBuffer()));
        if (!input.isConnected || input.files?.[0] !== original) return;
        const hash = Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
        if (hash !== chart.audioSha256) {
          setAttachmentError('コード譜と同じ音源ファイルを選んでください。');
          return;
        }
      } catch {
        if (input.isConnected && input.files?.[0] === original) setAttachmentError('この音源を再生できませんでした。');
        return;
      }
    }
    onAttach(original);
  }
  return (
    <section className="min-w-0 overflow-hidden rounded-panel border border-yt-outline bg-yt-tonal-solid" aria-label={t('コード譜')}>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-yt-outline px-4 py-4 sm:px-5">
        <div className="min-w-0">
          <h2 className="break-words text-lg font-bold">{chart.title}</h2>
          {chart.artist && <p className="mt-1 text-sm text-yt-text-secondary">{chart.artist}</p>}
        </div>
        <dl className="flex flex-wrap gap-4 text-sm tabular-nums">
          <div><dt className="text-xs text-yt-text-secondary">{t('キー')}</dt><dd className="font-semibold">{key ? `${NOTE_NAMES[key.root]} ${key.mode}` : '—'}</dd></div>
          <div><dt className="text-xs text-yt-text-secondary">BPM</dt><dd className="font-semibold">{chart.bpm ?? '—'}</dd></div>
          <div><dt className="text-xs text-yt-text-secondary">{t('再生位置')}</dt><dd className="font-semibold">{formatClockDuration(Math.max(0, time))}</dd></div>
        </dl>
      </div>
      {videoId ? (
        <>
          <div ref={videoHost} className="m-auto aspect-video min-h-[200px] w-full max-w-[720px] bg-black [&>iframe]:block" />
          {mediaError && (
            <p role="alert" className="flex flex-wrap items-center gap-3 p-4 text-sm">
              {t('YouTube動画を再生できませんでした。')}
              <button className="cursor-pointer text-yt-link underline" onClick={() => {
                setMediaError(false);
                setVideoReady(false);
                setRetry(value => value + 1);
              }}>{t('再試行')}</button>
            </p>
          )}
        </>
      ) : chart.id === 'demo' || file ? (
        <div className="p-4">
          <audio
            aria-label={chart.title}
            className="block h-10 w-full"
            ref={audio}
            controls
            preload="metadata"
            onPlay={() => usePlayerStore.getState().pause()}
            onTimeUpdate={event => setTime(event.currentTarget.currentTime)}
            onLoadedMetadata={event => setTime(event.currentTarget.currentTime)}
            onError={() => setMediaError(true)}
          />
          {mediaError && <p role="alert" className="mt-2 text-sm">{t('この音源を再生できませんでした。')}</p>}
        </div>
      ) : (
        <label className="block p-4 text-sm">
          <span className="mb-2 block">{t('再生するには、解析に使った音源を選んでください。')}</span>
          <input type="file" accept="audio/*,.flac,.m4a,.mp3,.wav,.ogg" onChange={attachAudio}
            className="w-full text-yt-text-secondary file:mr-3 file:rounded-full file:border-0 file:bg-yt-tonal-hover file:px-3 file:py-1.5 file:text-yt-text" />
          {attachmentError && <span className="mt-2 block" role="alert">{t(attachmentError)}</span>}
        </label>
      )}
      <div className="px-4 pb-4 pt-2 sm:px-5">
        {chart.chords.length ? (
          <>
            <div className="flex min-h-16 items-center gap-4">
              <div className="min-w-20">
                <p className="text-xs text-yt-text-secondary">{t('演奏中のコード')}</p>
                <p className="text-2xl font-bold">{segment ? chordName(segment.value) : '—'}</p>
                {segment?.review && <p className="text-xs text-yt-text-secondary">{t('要確認')}</p>}
              </div>
              {next && (
                <div className="border-l border-yt-outline pl-4">
                  <p className="text-xs text-yt-text-secondary">{t('次のコード')}</p>
                  <p className="text-lg font-semibold">{chordName(next.value)}</p>
                </div>
              )}
            </div>
            <div ref={rail} className="relative flex gap-1.5 overflow-x-auto pb-2" aria-label={t('コードのタイムライン')}>
              {chart.chords.map(({ start, end, value, review }, i) => {
                const tonic = keyAt(chart, (start + end) / 2);
                return (
                <button key={start} ref={i === active ? activeButton : undefined} type="button"
                  aria-current={i === active ? 'true' : undefined}
                  disabled={!canJump}
                  onClick={() => setLocalJump({ request: jump, start })}
                  className={cx('grid min-w-16 shrink-0 gap-1 rounded-row border px-2.5 py-2 text-left tabular-nums enabled:cursor-pointer',
                    i === active ? 'border-yt-inverse bg-yt-inverse text-yt-on-inverse' : 'border-yt-outline enabled:hover:bg-yt-tonal-hover')}>
                  <span className="font-bold">{chordName(value)}</span>
                  <span className="text-xs opacity-80">{formatClockDuration(start)}{tonic ? ` · ${DEGREES[pitchClass(value.root - tonic.root)]}${value.quality}` : ''}</span>
                  {review && <span className="text-xs opacity-80">{t('要確認')}</span>}
                </button>
                );
              })}
            </div>
          </>
        ) : <p className="text-sm text-yt-text-secondary">{t('コードを推定できませんでした。')}</p>}
        {chart.id !== 'demo' && <p className="mt-2 text-xs text-yt-text-secondary">{t('キー・BPM・コードは音源からの推定です。')}</p>}
      </div>
    </section>
  );
}
