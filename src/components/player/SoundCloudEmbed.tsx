import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { PV } from '../../types/vocadb';
import { usePlayerStore } from '../../stores/playerStore';
import { useProgressStore } from '../../stores/progressStore';
import { buildSoundCloudEmbedUrl } from '../../utils/playablePV';
import { getPlaybackOwnership } from '../../services/playbackOwnership';
import { hasReachedPlaybackEnd } from '../../services/playbackEndRecovery';
import { usePlaybackWakeRecovery } from '../../hooks/usePlaybackWakeRecovery';

interface SoundCloudProgressEvent {
  currentPosition?: number;
}

interface SoundCloudWidget {
  bind(eventName: string, listener: (event?: SoundCloudProgressEvent) => void): void;
  unbind(eventName: string): void;
  play(): void;
  pause(): void;
  seekTo(milliseconds: number): void;
  setVolume(volume: number): void;
  getDuration(callback: (milliseconds: number) => void): void;
  getPosition?(callback: (milliseconds: number) => void): void;
  isPaused(callback: (paused: boolean) => void): void;
}

interface SoundCloudWidgetFactory {
  (iframe: HTMLIFrameElement): SoundCloudWidget;
  Events: {
    READY: string;
    PLAY: string;
    PAUSE: string;
    FINISH: string;
    SEEK: string;
    PLAY_PROGRESS: string;
    ERROR: string;
  };
}

declare global {
  interface Window {
    SC?: { Widget: SoundCloudWidgetFactory };
  }
}

let soundCloudApiPromise: Promise<SoundCloudWidgetFactory> | null = null;

function loadSoundCloudWidgetApi(): Promise<SoundCloudWidgetFactory> {
  if (window.SC?.Widget) return Promise.resolve(window.SC.Widget);
  if (soundCloudApiPromise) return soundCloudApiPromise;

  const promise = new Promise<SoundCloudWidgetFactory>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>('script[data-diva-soundcloud-widget]');
    const script = existing ?? document.createElement('script');
    const handleLoad = () => {
      if (window.SC?.Widget) resolve(window.SC.Widget);
      else reject(new Error('SoundCloud Widget API did not initialize'));
    };
    const handleError = () => reject(new Error('SoundCloud Widget API failed to load'));
    script.addEventListener('load', handleLoad, { once: true });
    script.addEventListener('error', handleError, { once: true });
    if (!existing) {
      script.src = 'https://w.soundcloud.com/player/api.js';
      script.async = true;
      script.dataset.divaSoundcloudWidget = 'true';
      document.head.appendChild(script);
    }
  }).catch(error => {
    soundCloudApiPromise = null;
    throw error;
  });
  soundCloudApiPromise = promise;
  return promise;
}

interface SoundCloudEmbedProps {
  pv: PV;
  isPlaying: boolean;
}

export default function SoundCloudEmbed({ pv, isPlaying }: SoundCloudEmbedProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const widgetRef = useRef<SoundCloudWidget | null>(null);
  const requestedPlayingRef = useRef(isPlaying);
  const initialAutoplayRef = useRef(isPlaying);
  const playbackSyncIdRef = useRef(0);
  const pendingPlaybackTargetRef = useRef<boolean | null>(null);
  const pauseConfirmationTimerRef = useRef<number | null>(null);
  const playbackRetryTimerRef = useRef<number | null>(null);
  const volume = usePlayerStore(state => state.volume);
  const setIsPlaying = usePlayerStore(state => state.setIsPlaying);
  const markPVHealthy = usePlayerStore(state => state.markPVHealthy);
  const setError = usePlayerStore(state => state.setError);
  const tryNextPV = usePlayerStore(state => state.tryNextPV);
  const next = usePlayerStore(state => state.next);
  const seekTarget = usePlayerStore(state => state.seekTarget);
  const clearSeekTarget = usePlayerStore(state => state.clearSeekTarget);
  const setProgress = useProgressStore(state => state.setProgress);
  const setDuration = useProgressStore(state => state.setDuration);
  const embedUrl = useMemo(
    () => buildSoundCloudEmbedUrl(pv, initialAutoplayRef.current),
    [pv],
  );

  const clearPauseConfirmation = useCallback(() => {
    if (pauseConfirmationTimerRef.current === null) return;
    window.clearTimeout(pauseConfirmationTimerRef.current);
    pauseConfirmationTimerRef.current = null;
  }, []);

  const clearPlaybackRetry = useCallback(() => {
    if (playbackRetryTimerRef.current === null) return;
    window.clearTimeout(playbackRetryTimerRef.current);
    playbackRetryTimerRef.current = null;
  }, []);

  const syncWidgetPlayback = useCallback((widget: SoundCloudWidget, shouldPlay: boolean) => {
    const syncId = ++playbackSyncIdRef.current;
    widget.isPaused(paused => {
      if (widgetRef.current !== widget || playbackSyncIdRef.current !== syncId) return;
      if (requestedPlayingRef.current !== shouldPlay) return;

      const widgetIsPlaying = !paused;
      if (widgetIsPlaying === shouldPlay) {
        pendingPlaybackTargetRef.current = null;
        if (shouldPlay) clearPlaybackRetry();
        return;
      }

      pendingPlaybackTargetRef.current = shouldPlay;
      if (shouldPlay) widget.play();
      else widget.pause();
    });
  }, [clearPlaybackRetry]);

  const scheduleWidgetPlayback = useCallback((widget: SoundCloudWidget, initialDelayMs = 0) => {
    clearPlaybackRetry();
    if (!requestedPlayingRef.current) return;
    const retry = () => {
      playbackRetryTimerRef.current = null;
      if (widgetRef.current !== widget || !requestedPlayingRef.current) return;
      // Arm first so an asynchronous isPaused confirmation can cancel it as
      // soon as playback is known to be active.
      playbackRetryTimerRef.current = window.setTimeout(retry, 1_000);
      syncWidgetPlayback(widget, true);
    };
    playbackRetryTimerRef.current = window.setTimeout(retry, initialDelayMs);
  }, [clearPlaybackRetry, syncWidgetPlayback]);

  useEffect(() => {
    if (embedUrl) return;
    setError('SoundCloudの再生URLを判定できませんでした');
    tryNextPV();
  }, [embedUrl, setError, tryNextPV]);

  useEffect(() => {
    if (!embedUrl) return;
    let active = true;
    let factory: SoundCloudWidgetFactory | null = null;
    let widget: SoundCloudWidget | null = null;

    void loadSoundCloudWidgetApi().then(loadedFactory => {
      if (!active || !iframeRef.current) return;
      factory = loadedFactory;
      widget = factory(iframeRef.current);
      widgetRef.current = widget;
      const events = factory.Events;

      widget.bind(events.READY, () => {
        if (!active || !widget) return;
        markPVHealthy(pv);
        widget.setVolume(usePlayerStore.getState().volume);
        widget.getDuration(milliseconds => {
          if (active && Number.isFinite(milliseconds) && milliseconds > 0) {
            setDuration(milliseconds / 1000);
          }
        });
        if (requestedPlayingRef.current) scheduleWidgetPlayback(widget);
        else syncWidgetPlayback(widget, false);
      });
      widget.bind(events.PLAY, () => {
        if (!active) return;
        clearPauseConfirmation();
        clearPlaybackRetry();
        pendingPlaybackTargetRef.current = null;
        requestedPlayingRef.current = true;
        markPVHealthy(pv);
        if (!usePlayerStore.getState().isPlaying) setIsPlaying(true);
      });
      widget.bind(events.PAUSE, () => {
        const activeWidget = widget;
        if (!active || !activeWidget) return;

        // SoundCloud can emit a stale PAUSE while a play request is settling.
        // Confirm the actual widget state before changing the global player,
        // otherwise PLAY/PAUSE commands can feed back into each other.
        if (requestedPlayingRef.current || pendingPlaybackTargetRef.current === true) {
          clearPauseConfirmation();
          pauseConfirmationTimerRef.current = window.setTimeout(() => {
            pauseConfirmationTimerRef.current = null;
            if (!active || widgetRef.current !== activeWidget) return;
            activeWidget.isPaused(paused => {
              if (!active || widgetRef.current !== activeWidget) return;
              pendingPlaybackTargetRef.current = null;
              if (!paused) return;
              if (document.hidden && usePlayerStore.getState().isPlaying) {
                requestedPlayingRef.current = true;
                scheduleWidgetPlayback(activeWidget);
                return;
              }
              requestedPlayingRef.current = false;
              if (usePlayerStore.getState().isPlaying) setIsPlaying(false);
            });
          }, 350);
          return;
        }

        pendingPlaybackTargetRef.current = null;
        requestedPlayingRef.current = false;
        if (usePlayerStore.getState().isPlaying) setIsPlaying(false);
      });
      widget.bind(events.FINISH, () => {
        if (active) next();
      });
      widget.bind(events.PLAY_PROGRESS, event => {
        const milliseconds = event?.currentPosition;
        if (active && typeof milliseconds === 'number') setProgress(milliseconds / 1000);
      });
      widget.bind(events.SEEK, event => {
        const milliseconds = event?.currentPosition;
        if (active && typeof milliseconds === 'number') setProgress(milliseconds / 1000);
      });
      widget.bind(events.ERROR, () => {
        if (!active) return;
        setError('SoundCloudトラックを再生できませんでした');
        tryNextPV();
      });
    }).catch(() => {
      if (!active) return;
      setError('SoundCloudプレイヤーを読み込めませんでした');
      tryNextPV();
    });

    return () => {
      active = false;
      clearPauseConfirmation();
      clearPlaybackRetry();
      playbackSyncIdRef.current += 1;
      pendingPlaybackTargetRef.current = null;
      widgetRef.current = null;
      if (!factory || !widget) return;
      Object.values(factory.Events).forEach(eventName => widget?.unbind(eventName));
    };
  }, [clearPauseConfirmation, clearPlaybackRetry, embedUrl, markPVHealthy, next, pv, scheduleWidgetPlayback, setDuration, setError, setIsPlaying, setProgress, syncWidgetPlayback, tryNextPV]);

  useEffect(() => {
    requestedPlayingRef.current = isPlaying;
    const widget = widgetRef.current;
    if (!widget) return;
    if (isPlaying) scheduleWidgetPlayback(widget);
    else {
      clearPlaybackRetry();
      syncWidgetPlayback(widget, false);
    }
  }, [clearPlaybackRetry, isPlaying, scheduleWidgetPlayback, syncWidgetPlayback]);

  const recoverPlayback = useCallback(() => {
    const widget = widgetRef.current;
    const state = usePlayerStore.getState();
    if (!widget || !state.isPlaying || getPlaybackOwnership().getState() !== 'local') return;
    requestedPlayingRef.current = true;
    const resume = (milliseconds?: number) => {
      if (widgetRef.current !== widget) return;
      const seconds = typeof milliseconds === 'number' && Number.isFinite(milliseconds)
        ? milliseconds / 1000
        : useProgressStore.getState().progress;
      if (typeof milliseconds === 'number') setProgress(seconds);
      if (hasReachedPlaybackEnd(seconds, useProgressStore.getState().duration)) {
        next();
        return;
      }
      scheduleWidgetPlayback(widget);
    };
    if (widget.getPosition) widget.getPosition(resume);
    else resume();
  }, [next, scheduleWidgetPlayback, setProgress]);
  usePlaybackWakeRecovery(recoverPlayback);

  useEffect(() => {
    widgetRef.current?.setVolume(volume);
  }, [volume]);

  useEffect(() => {
    if (seekTarget === null || !widgetRef.current) return;
    widgetRef.current.seekTo(seekTarget * 1000);
    setProgress(seekTarget);
    clearSeekTarget();
  }, [clearSeekTarget, seekTarget, setProgress]);

  if (!embedUrl) return null;

  return (
    <iframe
      ref={iframeRef}
      data-testid="soundcloud-player-embed"
      src={embedUrl}
      title={pv.name || 'SoundCloud player'}
      className="h-full w-full"
      allow="autoplay"
      style={{ border: 'none' }}
    />
  );
}
