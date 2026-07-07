import { useEffect } from 'react';
import { usePlayerStore } from '../../stores/playerStore';
import { useProgressStore } from '../../stores/progressStore';

export default function MediaSession() {
  const currentSong = usePlayerStore(s => s.currentSong);
  const isPlaying = usePlayerStore(s => s.isPlaying);
  const pause = usePlayerStore(s => s.pause);
  const resume = usePlayerStore(s => s.resume);
  const next = usePlayerStore(s => s.next);
  const previous = usePlayerStore(s => s.previous);
  const seekTo = usePlayerStore(s => s.seekTo);
  const progress = useProgressStore(s => s.progress);
  const duration = useProgressStore(s => s.duration);

  useEffect(() => {
    if (!('mediaSession' in navigator)) return;

    if (!currentSong) {
      navigator.mediaSession.metadata = null;
      navigator.mediaSession.playbackState = 'none';
      return;
    }

    navigator.mediaSession.metadata = new MediaMetadata({
      title: currentSong.name,
      artist: currentSong.artistString || undefined,
      artwork: currentSong.thumbUrl
        ? [
            {
              src: currentSong.thumbUrl,
              sizes: '512x512',
              type: 'image/jpeg',
            },
          ]
        : undefined,
    });
  }, [currentSong]);

  useEffect(() => {
    if (!('mediaSession' in navigator)) return;

    navigator.mediaSession.playbackState = currentSong
      ? isPlaying ? 'playing' : 'paused'
      : 'none';
  }, [currentSong, isPlaying]);

  useEffect(() => {
    if (!('mediaSession' in navigator)) return;

    navigator.mediaSession.setActionHandler('play', resume);
    navigator.mediaSession.setActionHandler('pause', pause);
    navigator.mediaSession.setActionHandler('previoustrack', previous);
    navigator.mediaSession.setActionHandler('nexttrack', next);
    navigator.mediaSession.setActionHandler('seekbackward', () => seekTo(Math.max(0, progress - 10)));
    navigator.mediaSession.setActionHandler('seekforward', () => seekTo(Math.min(duration, progress + 10)));

    return () => {
      navigator.mediaSession.setActionHandler('play', null);
      navigator.mediaSession.setActionHandler('pause', null);
      navigator.mediaSession.setActionHandler('previoustrack', null);
      navigator.mediaSession.setActionHandler('nexttrack', null);
      navigator.mediaSession.setActionHandler('seekbackward', null);
      navigator.mediaSession.setActionHandler('seekforward', null);
    };
  }, [duration, next, pause, previous, progress, resume, seekTo]);

  return null;
}
