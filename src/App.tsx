import { useEffect, useRef } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Layout from './components/layout/Layout';
import HomePage from './pages/HomePage';
import WatchPage from './pages/WatchPage';
import PlaylistPage from './pages/PlaylistPage';
import HistoryPage from './pages/HistoryPage';
import FavoritesPage from './pages/FavoritesPage';
import { usePlayerStore } from './stores/playerStore';
import { useHistoryStore } from './stores/historyStore';
import { useRatingStore } from './stores/ratingStore';
import { useProgressStore } from './stores/progressStore';
import { getRecommendedSongs, sendPlayFeedback } from './api/vocadb';

/**
 * App - ルートコンポーネント
 * 
 * BrowserRouter + Layout でSPA構成を実現。
 * ページ遷移してもLayout内のPlayerBarは維持され、
 * 音楽再生が途切れない。
 */

/** フィッシャー–イェーツシャッフル */
function shuffleArray<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function PlayerTracker() {
  const currentSong = usePlayerStore(s => s.currentSong);
  const queue = usePlayerStore(s => s.queue);
  const queueIndex = usePlayerStore(s => s.queueIndex);
  const addManyToQueue = usePlayerStore(s => s.addManyToQueue);
  const progress = useProgressStore(s => s.progress);
  const duration = useProgressStore(s => s.duration);
  
  const { addToHistory } = useHistoryStore();
  const { ratings } = useRatingStore();
  const fetchingForRef = useRef<number | null>(null);
  const ratingsRef = useRef(ratings);
  ratingsRef.current = ratings;

  // 再生完了率トラッキング
  const prevSongRef  = useRef<{ id: number; progress: number; duration: number } | null>(null);
  const progressRef  = useRef(progress);
  const durationRef  = useRef(duration);
  progressRef.current = progress;
  durationRef.current = duration;

  // 視聴履歴 + 暗黙的フィードバック
  useEffect(() => {
    if (!currentSong) return;

    // 前の曲の再生完了率を送信
    if (prevSongRef.current && prevSongRef.current.id !== currentSong.id) {
      const { id, progress: p, duration: d } = prevSongRef.current;
      const completionRate = d > 0 ? Math.min(1, p / d) : 0;
      sendPlayFeedback(id, completionRate);
    }

    prevSongRef.current = {
      id: currentSong.id,
      progress: progressRef.current,
      duration: durationRef.current,
    };

    addToHistory(currentSong);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentSong?.id]);

  // progress/duration を prevSongRef に反映
  useEffect(() => {
    if (prevSongRef.current && currentSong && prevSongRef.current.id === currentSong.id) {
      prevSongRef.current = { id: currentSong.id, progress, duration };
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [progress, duration]);

  // 自動キュー: キューの残りが少なくなったら推薦曲をシャッフルして自動追加 (常時ON)
  useEffect(() => {
    if (!currentSong) return;
    if (fetchingForRef.current === currentSong.id) return;

    const remaining = queue.length - 1 - queueIndex;
    if (remaining > 2) return;

    const songId = currentSong.id;
    fetchingForRef.current = songId;
    const existingIds = new Set(queue.map(s => s.id));

    getRecommendedSongs(songId, 40, undefined, 0.0, ratingsRef.current)
      .then(related => {
        const newSongs = shuffleArray(
          related.filter(s => !existingIds.has(s.id))
        ).slice(0, 40);
        addManyToQueue(newSongs);
      })
      .catch(() => {
        if (fetchingForRef.current === songId) {
          fetchingForRef.current = null;
        }
      });
  // eslint-disable-next-line react-deps
  }, [currentSong?.id, queueIndex, queue.length]);

  return null;
}

function AppContent() {
  return (
    <>
      <PlayerTracker />
      <Routes>
        <Route element={<Layout />}>
          <Route path="/" element={<HomePage />} />
          <Route path="/watch" element={<WatchPage />} />
          <Route path="/history" element={<HistoryPage />} />
          <Route path="/favorites" element={<FavoritesPage />} />
          <Route path="/playlists" element={<PlaylistPage />} />
          {/* 旧ルートの互換性 */}
          <Route path="/playing" element={<WatchPage />} />
        </Route>
      </Routes>
    </>
  );
}

export default function App() {
  return (
    <BrowserRouter basename={import.meta.env.BASE_URL}>
      <AppContent />
    </BrowserRouter>
  );
}
