import { useEffect, useState } from 'react';
import { usePlayerStore } from '../../stores/playerStore';

function buildSongUrl(songId: number): string {
  const basePath = import.meta.env.BASE_URL.replace(/\/$/, '');
  return `${window.location.origin}${basePath}/watch?v=${songId}`;
}

export default function ShareCurrentSong() {
  const currentSong = usePlayerStore(s => s.currentSong);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;

    const timeoutId = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timeoutId);
  }, [copied]);

  const copyUrl = async () => {
    if (!currentSong) return;

    const url = buildSongUrl(currentSong.id);
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(url);
    } else {
      const textArea = document.createElement('textarea');
      textArea.value = url;
      textArea.style.position = 'fixed';
      textArea.style.opacity = '0';
      document.body.appendChild(textArea);
      textArea.select();
      document.execCommand('copy');
      document.body.removeChild(textArea);
    }
    setCopied(true);
  };

  return (
    <button
      className="btn-ghost p-1.5 rounded-lg"
      onClick={copyUrl}
      disabled={!currentSong}
      title={copied ? 'コピーしました' : '曲リンクをコピー'}
      style={{ color: copied ? 'var(--color-accent-cyan)' : 'var(--color-text-muted)' }}
    >
      {copied ? (
        <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor">
          <path d="M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
        </svg>
      ) : (
        <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor">
          <path d="M18 16.08c-.76 0-1.44.3-1.96.77L8.91 12.7c.05-.23.09-.46.09-.7s-.04-.47-.09-.7l7.05-4.11A2.99 2.99 0 1 0 15 5c0 .24.04.47.09.7L8.04 9.81A2.99 2.99 0 1 0 8.04 14.2l7.12 4.18c-.05.2-.08.41-.08.62a2.92 2.92 0 1 0 2.92-2.92z"/>
        </svg>
      )}
    </button>
  );
}
