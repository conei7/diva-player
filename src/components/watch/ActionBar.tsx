import { useState } from 'react';
import StarRating from '../player/StarRating';
import { useRatingStore } from '../../stores/ratingStore';
import { useUiStore } from '../../stores/uiStore';
import { usePlaylistStore, WATCH_LATER_ID } from '../../stores/playlistStore';
import type { Song } from '../../types/vocadb';
import { useHiddenSongStore } from '../../stores/hiddenSongStore';
import { usePlayerStore } from '../../stores/playerStore';

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
  const toggleSongInPlaylist = usePlaylistStore(state => state.toggleSongInPlaylist);
  const getOrCreateWatchLater = usePlaylistStore(state => state.getOrCreateWatchLater);
  const isSongInPlaylist = usePlaylistStore(state => state.isSongInPlaylist);
  const hidden = useHiddenSongStore(state => Boolean(state.hiddenSongs[String(song.id)]));
  const hideSong = useHiddenSongStore(state => state.hideSong);
  const restoreSong = useHiddenSongStore(state => state.restoreSong);
  const { currentSong, queue, queueIndex, removeFromQueue, closePlayer } = usePlayerStore();
  const rating = getRating(song.id);
  const isWatchLater = isSongInPlaylist(WATCH_LATER_ID, song.id);
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

  const handleWatchLater = () => {
    // Layout loads playlists asynchronously; ensure the system playlist exists
    // even if the user clicks immediately after opening a watch page.
    getOrCreateWatchLater();
    toggleSongInPlaylist(WATCH_LATER_ID, song);
  };

  const handleHidden = () => {
    if (hidden) {
      restoreSong(song.id);
      return;
    }
    hideSong(song);
    if (currentSong?.id !== song.id) return;
    if (queueIndex >= 0 && queue[queueIndex]?.id === song.id) removeFromQueue(queueIndex);
    else closePlayer();
  };


  return (
    <div className="flex flex-wrap items-center gap-2 mt-3 pb-3 border-b" style={{ borderColor: 'var(--color-border)' }}>
      {/* ─── 5段階スター評価 ─── */}
      <div
        className="watch-action-rating flex items-center gap-1 rounded-full px-2 py-1 sm:gap-2 sm:px-4 sm:py-2"
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

      {/* ─── 後で聴く（固定プレイリスト）ボタン ─── */}
      <div className="relative">
        <button
          className="yt-action-btn"
          onClick={handleWatchLater}
          title={isWatchLater ? '後で聴くから削除' : '後で聴く'}
          aria-label={isWatchLater ? '後で聴くから削除' : '後で聴く'}
          style={isWatchLater ? { color: 'var(--color-accent-cyan)' } : undefined}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill={isWatchLater ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="9" />
            <polyline points="12 7 12 12 15.5 14" />
          </svg>
          <span className="hidden sm:inline">後で聴く</span>
        </button>
      </div>

      {/* 明示的な否定フィードバック。星1とは別に、今後の候補から除外する。 */}
      <div className="relative">
        <button
          type="button"
          className="yt-action-btn"
          onClick={handleHidden}
          title={hidden ? '表示しない設定を解除' : '好みではない・今後表示しない'}
          aria-label={hidden ? '表示しない設定を解除' : '好みではない・今後表示しない'}
          aria-pressed={hidden}
          style={hidden ? { color: '#fb7185', background: 'rgba(244, 63, 94, 0.12)' } : undefined}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill={hidden ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M17 3H6.7a2 2 0 0 0-1.9 1.4L3 10v2h5.5L7 18.2A2.3 2.3 0 0 0 9.2 21L15 13V5a2 2 0 0 1 2-2Z" />
            <path d="M17 3h4v10h-6" />
          </svg>
          <span className="hidden sm:inline">{hidden ? '再表示' : '表示しない'}</span>
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
