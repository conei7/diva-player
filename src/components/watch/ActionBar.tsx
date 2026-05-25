import { useState } from 'react';
import StarRating from '../player/StarRating';
import { useRatingStore } from '../../stores/ratingStore';
import { useUiStore } from '../../stores/uiStore';
import type { Song } from '../../types/vocadb';

/**
 * ActionBar - YouTube風アクションバー
 *
 * 最大の独自機能: YouTubeの「高評価/低評価」の代わりに、
 * 独自の5段階スター評価UIを配置。
 * 横に「共有」「保存」などの丸角ボタンを並べる。
 */
interface ActionBarProps {
  song: Song;
}

export default function ActionBar({ song }: ActionBarProps) {
  const { getRating, setRating } = useRatingStore();
  const { openSaveToPlaylist } = useUiStore();
  const rating = getRating(song.id);
  const [shareToast, setShareToast] = useState(false);

  const handleShare = async () => {
    const url = window.location.href;
    try {
      await navigator.clipboard.writeText(url);
      setShareToast(true);
      setTimeout(() => setShareToast(false), 2000);
    } catch {
      // フォールバック
      const textArea = document.createElement('textarea');
      textArea.value = url;
      document.body.appendChild(textArea);
      textArea.select();
      document.execCommand('copy');
      document.body.removeChild(textArea);
      setShareToast(true);
      setTimeout(() => setShareToast(false), 2000);
    }
  };

  const handleSave = () => {
    openSaveToPlaylist(song);
  };


  return (
    <div className="flex flex-wrap items-center gap-2 mt-3 pb-3 border-b" style={{ borderColor: 'var(--color-border)' }}>
      {/* ─── 5段階スター評価 ─── */}
      <div
        className="flex items-center gap-2 px-4 py-2 rounded-full"
        style={{ background: 'var(--color-yt-chip)' }}
      >
        <StarRating
          rating={rating}
          onRate={(r) => setRating(song.id, r)}
          size="md"
        />
      </div>

      {/* ─── 共有ボタン ─── */}
      <div className="relative">
        <button className="yt-action-btn" onClick={handleShare}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
            <path d="M14 9V3.5L20.5 10 14 16.5V11c-5.5 0-9.35 1.65-12 5.5C3 11 6.5 5.5 14 4.5V9z" />
          </svg>
          <span className="hidden sm:inline">共有</span>
        </button>
        {shareToast && (
          <div
            className="absolute -bottom-10 left-1/2 -translate-x-1/2 px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap animate-fade-in"
            style={{ background: 'var(--color-accent-cyan)', color: '#000' }}
          >
            URLをコピーしました
          </div>
        )}
      </div>

      {/* ─── 保存（プレイリストに保存）ボタン ─── */}
      <div className="relative">
        <button className="yt-action-btn" onClick={handleSave}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
            <path d="M14 10H2v2h12v-2zm0-4H2v2h12V6zm4 8v-4h-2v4h-4v2h4v4h2v-4h4v-2h-4zM2 16h8v-2H2v2z" />
          </svg>
          <span className="hidden sm:inline">保存</span>
        </button>
      </div>

      {/* ─── VocaDB リンク ─── */}
      <a
        href={`https://vocadb.net/S/${song.id}`}
        target="_blank"
        rel="noopener noreferrer"
        className="yt-action-btn"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
          <path d="M19 19H5V5h7V3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2v-7h-2v7zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z" />
        </svg>
        <span className="hidden sm:inline">VocaDB</span>
      </a>
    </div>
  );
}
