import { lazy, Suspense, useEffect, useRef } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Layout from './components/layout/Layout';
import MediaSession from './components/player/MediaSession';
import KeyboardShortcuts from './components/player/KeyboardShortcuts';
import { usePlayerStore } from './stores/playerStore';
import { useHistoryStore } from './stores/historyStore';
import { useRatingStore } from './stores/ratingStore';
import { useProgressStore } from './stores/progressStore';
import { usePlaylistStore } from './stores/playlistStore';
import { useImplicitFeedbackStore } from './stores/implicitFeedbackStore';
import { useAutoPlaySessionStore } from './stores/autoPlaySessionStore';
import { useAutoQueue } from './hooks/useAutoQueue';

const HomePage = lazy(() => import('./pages/HomePage'));
const WatchPage = lazy(() => import('./pages/WatchPage'));
const PlaylistPage = lazy(() => import('./pages/PlaylistPage'));
const HistoryPage = lazy(() => import('./pages/HistoryPage'));
const FavoritesPage = lazy(() => import('./pages/FavoritesPage'));

/**
 * App - ルートコンポーネント
 * 
 * BrowserRouter + Layout でSPA構成を実現。
 * ページ遷移してもLayout内のPlayerBarは維持され、
 * 音楽再生が途切れない。
 */

function PlayerTracker() {
  const currentSong = usePlayerStore(s => s.currentSong);
  const rootSeed = usePlayerStore(s => s.rootSeed);
  const mixMode = usePlayerStore(s => s.mixMode);
  const queue = usePlayerStore(s => s.queue);
  const queueIndex = usePlayerStore(s => s.queueIndex);
  const addManyToQueue = usePlayerStore(s => s.addManyToQueue);
  const currentPlaybackSource = usePlayerStore(s => s.currentPlaybackSource);
  const currentPlaybackSequence = usePlayerStore(s => s.playbackSequence);
  const progress = useProgressStore(s => s.progress);
  const duration = useProgressStore(s => s.duration);
  
  const { addToHistory, finalizeHistoryEntry, entries: historyEntries } = useHistoryStore();
  const { ratings } = useRatingStore();
  const { playlists } = usePlaylistStore();
  const implicitFeedback = useImplicitFeedbackStore(s => s.feedback);
  const autoPlayedCount = useAutoPlaySessionStore(s => s.session?.autoPlayedCount ?? 0);

  // 再生完了率トラッキング
  const prevSongRef = useRef<{
    id: number;
    progress: number;
    duration: number;
    source: 'manual' | 'auto';
    playbackSequence: number;
  } | null>(null);
  const finalizedPlaybackSequenceRef = useRef<number | null>(null);
  const progressRef  = useRef(progress);
  const durationRef  = useRef(duration);
  progressRef.current = progress;
  durationRef.current = duration;

  const finalizePreviousPlayback = (previous: NonNullable<typeof prevSongRef.current>) => {
    if (finalizedPlaybackSequenceRef.current === previous.playbackSequence) return;
    finalizedPlaybackSequenceRef.current = previous.playbackSequence;
    finalizeHistoryEntry(previous.id, previous.progress, previous.duration, previous.playbackSequence);
    useImplicitFeedbackStore.getState().recordPlayback(
      previous.id,
      previous.progress,
      previous.duration,
      previous.source,
    );
    if (previous.source === 'auto' && previous.duration > 0 && previous.progress >= 8) {
      const completionRate = Math.max(0, Math.min(1, previous.progress / previous.duration));
      const outcome = previous.progress < 30 || completionRate < 0.2
        ? 'skip'
        : completionRate >= 0.7 ? 'complete' : 'neutral';
      useAutoPlaySessionStore.getState().recordAutoPlaybackOutcome(outcome);
    }
  };

  // 視聴履歴 + 暗黙的フィードバック
  useEffect(() => {
    if (!currentSong) {
      if (prevSongRef.current) finalizePreviousPlayback(prevSongRef.current);
      return;
    }

    // 前の曲の再生完了率を送信
    if (
      prevSongRef.current
      && (
        prevSongRef.current.id !== currentSong.id
        || prevSongRef.current.playbackSequence !== currentPlaybackSequence
      )
    ) {
      finalizePreviousPlayback(prevSongRef.current);
    }

    prevSongRef.current = {
      id: currentSong.id,
      progress: progressRef.current,
      duration: durationRef.current,
      source: currentPlaybackSource,
      playbackSequence: currentPlaybackSequence,
    };

    addToHistory(currentSong, currentPlaybackSource, currentPlaybackSequence);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentSong?.id, currentPlaybackSequence]);

  // progress/duration を prevSongRef に反映
  useEffect(() => {
    if (prevSongRef.current && currentSong && prevSongRef.current.id === currentSong.id) {
      prevSongRef.current = {
        id: currentSong.id,
        progress,
        duration,
        source: currentPlaybackSource,
        playbackSequence: prevSongRef.current.playbackSequence,
      };
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [progress, duration]);

  useEffect(() => {
    const finalizeOnPageHide = () => {
      if (prevSongRef.current) finalizePreviousPlayback(prevSongRef.current);
    };
    window.addEventListener('pagehide', finalizeOnPageHide);
    return () => window.removeEventListener('pagehide', finalizeOnPageHide);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useAutoQueue({
    currentSong,
    rootSeed,
    mixMode,
    queue,
    queueIndex,
    historyEntries,
    ratings,
    playlists,
    implicitFeedback,
    autoPlayedCount,
    addManyToQueue,
  });

  return null;
}

function AppContent() {
  return (
    <>
      <PlayerTracker />
      <MediaSession />
      <KeyboardShortcuts />
      <Suspense fallback={<div className="min-h-screen bg-zinc-950" aria-busy="true" />}>
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
      </Suspense>
    </>
  );
}

export default function App() {
  return (
    <BrowserRouter basename={import.meta.env.BASE_URL.replace(/\/$/, '')}>
      <AppContent />
    </BrowserRouter>
  );
}
