import { useEffect, useMemo, useRef } from 'react';
import type { PV } from '../../types/vocadb';
import { usePlayerStore } from '../../stores/playerStore';
import { useProgressStore } from '../../stores/progressStore';
import { buildSoundCloudEmbedUrl } from '../../utils/playablePV';

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
        if (requestedPlayingRef.current) widget.play();
      });
      widget.bind(events.PLAY, () => {
        if (!active) return;
        markPVHealthy(pv);
        setIsPlaying(true);
      });
      widget.bind(events.PAUSE, () => {
        if (active) setIsPlaying(false);
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
      widgetRef.current = null;
      if (!factory || !widget) return;
      Object.values(factory.Events).forEach(eventName => widget?.unbind(eventName));
    };
  }, [embedUrl, markPVHealthy, next, pv, setDuration, setError, setIsPlaying, setProgress, tryNextPV]);

  useEffect(() => {
    requestedPlayingRef.current = isPlaying;
    const widget = widgetRef.current;
    if (!widget) return;
    if (isPlaying) widget.play();
    else widget.pause();
  }, [isPlaying]);

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
