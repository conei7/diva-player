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
    // The official cross-origin iframe exposes a muted flag but no parent API
    // for setting an exact 0-100 volume. Always start muted so autoplay never
    // blasts at the iframe's independent remembered/default volume.
    () => buildBilibiliEmbedUrl(pv, initialAutoplayRef.current, true),
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
    <div className="relative h-full w-full">
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
      <div
        className="pointer-events-none absolute left-2 top-2 rounded px-2 py-1 text-[10px]"
        style={{ background: 'rgba(0, 0, 0, 0.72)', color: 'rgba(255, 255, 255, 0.86)' }}
      >
        安全のためミュート開始・動画内で音量調整
      </div>
    </div>
  );
}
