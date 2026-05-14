import { useEffect, useRef } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Layout from './components/layout/Layout';
import SearchPage from './pages/SearchPage';
import PlaylistPage from './pages/PlaylistPage';
import { usePlayerStore } from './stores/playerStore';
import { useHistoryStore } from './stores/historyStore';
import { useRatingStore } from './stores/ratingStore';
import { getRecommendedSongs, sendPlayFeedback } from './api/vocadb';

/**
 * App - ルートコンポーネント
 * 
 * BrowserRouter + Layout でSPA構成を実現。
 * ページ遷移してもLayout内のPlayerBarは維持され、
 * 音楽再生が途切れない。
 */
export default function App() {
  const { currentSong, queue, queueIndex, autoQueue, addToQueue, progress, duration } = usePlayerStore();
  const { addToHistory } = useHistoryStore();
  const { ratings } = useRatingStore();
  const fetchingForRef = useRef<number | null>(null);
  const ratingsRef = useRef(ratings);
  ratingsRef.current = ratings; // 再レンダーを発生させず常に最新値を保持

  // 再生完了率トラッキング: 曲が切り替わる直前の progress/duration を記録
  const prevSongRef  = useRef<{ id: number; progress: number; duration: number } | null>(null);
  const progressRef  = useRef(progress);
  const durationRef  = useRef(duration);
  progressRef.current = progress;
  durationRef.current = duration;

  // 視聴履歴 + 暗黙的フィードバック: currentSong が切り替わったら処理
  useEffect(() => {
    if (!currentSong) return;

    // 前の曲の再生完了率を送信
    if (prevSongRef.current && prevSongRef.current.id !== currentSong.id) {
      const { id, progress: p, duration: d } = prevSongRef.current;
      const completionRate = d > 0 ? Math.min(1, p / d) : 0;
      sendPlayFeedback(id, completionRate);
    }

    // 現在の曲を記録して次回の切り替え時に使えるようにする
    prevSongRef.current = {
      id: currentSong.id,
      progress: progressRef.current,
      duration: durationRef.current,
    };

    addToHistory(currentSong);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentSong?.id]);

  // progress/duration が更新されたら prevSongRef にも反映 (曲変更直前の値を正確に取得するため)
  useEffect(() => {
    if (prevSongRef.current && currentSong && prevSongRef.current.id === currentSong.id) {
      prevSongRef.current = { id: currentSong.id, progress, duration };
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [progress, duration]);

  // 自動キュー: キューの残りが少なくなったら関連曲を自動追加
  useEffect(() => {
    if (!autoQueue || !currentSong) return;
    if (fetchingForRef.current === currentSong.id) return; // 同じ曲では1回のみ

    const remaining = queue.length - 1 - queueIndex;
    if (remaining > 2) return; // まだ余裕あり

    const songId = currentSong.id;
    fetchingForRef.current = songId;
    const existingIds = new Set(queue.map(s => s.id));

    getRecommendedSongs(songId, 10, undefined, 0.0, ratingsRef.current)
      .then(related => {
        const newSongs = related
          .filter(s => !existingIds.has(s.id))
          .slice(0, 10);
        newSongs.forEach(s => addToQueue(s));
      })
      .catch(() => {
        // エラー時はリセットしてリトライ可能に
        if (fetchingForRef.current === songId) {
          fetchingForRef.current = null;
        }
      });
  // eslint-disable-next-line react-deps
  }, [currentSong?.id, queueIndex, autoQueue, queue.length]);

  return (
    <BrowserRouter basename="/diva-player">
      <Routes>
        <Route element={<Layout />}>
          <Route path="/" element={<SearchPage />} />
          <Route path="/playlists" element={<PlaylistPage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
