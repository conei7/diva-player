import { useEffect, useMemo, useRef } from 'react';
import type { PV } from '../../types/vocadb';
import { usePlayerStore } from '../../stores/playerStore';
import { useProgressStore } from '../../stores/progressStore';
import { buildBilibiliEmbedUrl } from '../../utils/playablePV';

interface BilibiliEmbedProps {
  pv: PV;
  isPlaying: boolean;
  duration?: number;
}

export default function BilibiliEmbed({ pv, isPlaying, duration }: BilibiliEmbedProps) {
  const initialAutoplayRef = useRef(isPlaying);
  const embedUrl = useMemo(
    // The official cross-origin iframe has no parent API for setting an exact
    // 0-100 volume. Keep it unmuted and let its own native player retain and
    // apply the user's Bilibili-side volume instead of forcing mute on every PV.
    () => buildBilibiliEmbedUrl(pv, initialAutoplayRef.current, false),
    [pv],
  );
  const markPVHealthy = usePlayerStore(state => state.markPVHealthy);
  const setError = usePlayerStore(state => state.setError);
  const tryNextPV = usePlayerStore(state => state.tryNextPV);
  const setDuration = useProgressStore(state => state.setDuration);

  useEffect(() => {
    if (duration && duration > 0) setDuration(duration);
  }, [duration, setDuration]);

  useEffect(() => {
    if (embedUrl) return;
    setError('Bilibiliの動画IDを判定できませんでした');
    tryNextPV();
  }, [embedUrl, setError, tryNextPV]);

  if (!embedUrl) return null;

  return (
    <iframe
      data-testid="bilibili-player-embed"
      src={embedUrl}
      title={pv.name || 'Bilibili player'}
      className="h-full w-full"
      allow="autoplay; fullscreen; picture-in-picture"
      allowFullScreen
      style={{ border: 'none' }}
      onLoad={() => markPVHealthy(pv)}
    />
  );
}
