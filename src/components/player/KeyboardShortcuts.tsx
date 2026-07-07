import { useEffect } from 'react';
import { usePlayerStore } from '../../stores/playerStore';
import { useProgressStore } from '../../stores/progressStore';

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;

  const tagName = target.tagName.toLowerCase();
  return (
    tagName === 'input' ||
    tagName === 'textarea' ||
    tagName === 'select' ||
    target.isContentEditable
  );
}

export default function KeyboardShortcuts() {
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
    function onKeyDown(event: KeyboardEvent) {
      if (!currentSong || event.repeat || isEditableTarget(event.target)) return;

      if (event.code === 'Space') {
        event.preventDefault();
        if (isPlaying) {
          pause();
        } else {
          resume();
        }
        return;
      }

      if (event.key === 'ArrowRight') {
        event.preventDefault();
        if (event.shiftKey) {
          next();
        } else {
          seekTo(Math.min(duration, progress + 5));
        }
        return;
      }

      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        if (event.shiftKey) {
          previous();
        } else {
          seekTo(Math.max(0, progress - 5));
        }
      }
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [currentSong, duration, isPlaying, next, pause, previous, progress, resume, seekTo]);

  return null;
}
