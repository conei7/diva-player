import { useEffect, useRef } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Layout from './components/layout/Layout';
import SearchPage from './pages/SearchPage';
import PlaylistPage from './pages/PlaylistPage';
import { usePlayerStore } from './stores/playerStore';
import { getRelatedSongs } from './api/vocadb';

/**
 * App - ルートコンポーネント
 * 
 * BrowserRouter + Layout でSPA構成を実現。
 * ページ遷移してもLayout内のPlayerBarは維持され、
 * 音楽再生が途切れない。
 */
export default function App() {
  const { currentSong, queue, queueIndex, autoQueue, addToQueue } = usePlayerStore();
  const fetchingForRef = useRef<number | null>(null);

  // 自動キュー: キューの残りが少なくなったら関連曲を自動追加
  useEffect(() => {
    if (!autoQueue || !currentSong) return;
    if (fetchingForRef.current === currentSong.id) return; // 同じ曲では1回のみ

    const remaining = queue.length - 1 - queueIndex;
    if (remaining > 2) return; // まだ余裕あり

    const songId = currentSong.id;
    fetchingForRef.current = songId;
    const existingIds = new Set(queue.map(s => s.id));

    getRelatedSongs(songId)
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
  // eslint-disable-next-line react-hooks/exhaustive-deps
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
