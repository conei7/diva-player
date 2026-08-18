import { lazy, useEffect, useRef } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router';
import Layout from './components/layout/Layout';
import MediaSession from './components/player/MediaSession';
import KeyboardShortcuts from './components/player/KeyboardShortcuts';
import GlobalPlayer from './components/player/GlobalPlayer';
import { usePlayerStore } from './stores/playerStore';
import { useHistoryStore } from './stores/historyStore';
import { useRatingStore } from './stores/ratingStore';
import { useProgressStore } from './stores/progressStore';
import { usePlaylistStore } from './stores/playlistStore';
import { useImplicitFeedbackStore } from './stores/implicitFeedbackStore';
import { useAutoPlaySessionStore } from './stores/autoPlaySessionStore';
import { useAutoQueueDecisionStore } from './stores/autoQueueDecisionStore';
import { useAutoQueueBanditStore } from './stores/autoQueueBanditStore';
import { useAutoQueue } from './hooks/useAutoQueue';
import AppErrorBoundary from './components/AppErrorBoundary';
import { formatDocumentTitle } from './utils/documentTitle';
import { shouldRecordPlayback } from './utils/playbackHistory';

const HomePage = lazy(() => import('./pages/HomePage'));
const WatchPage = lazy(() => import('./pages/WatchPage'));
const PlaylistPage = lazy(() => import('./pages/PlaylistPage'));
const HistoryPage = lazy(() => import('./pages/HistoryPage'));
const FavoritesPage = lazy(() => import('./pages/FavoritesPage'));
const FavoriteProducersPage = lazy(() => import('./pages/FavoriteProducersPage'));
const ReportsPage = lazy(() => import('./pages/ReportsPage'));
const HiddenSongsPage = lazy(() => import('./pages/HiddenSongsPage'));
const ChorusHighlightsPage = lazy(() => import('./pages/ChorusHighlightsPage'));
const KnowledgeMapPage = lazy(() => import('./pages/KnowledgeMapPage'));

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
  const queue = usePlayerStore(s => s.queue);
  const queueIndex = usePlayerStore(s => s.queueIndex);
  const addManyToQueue = usePlayerStore(s => s.addManyToQueue);
  const currentPlaybackSource = usePlayerStore(s => s.currentPlaybackSource);
  const currentPlaybackSequence = usePlayerStore(s => s.playbackSequence);
  const progress = useProgressStore(s => s.progress);
  const duration = useProgressStore(s => s.duration);
  
  const { addToHistory, finalizeHistoryEntry, entries: historyEntries, hasHydrated: historyHydrated } = useHistoryStore();
  const { ratings } = useRatingStore();
  const { playlists } = usePlaylistStore();
  const implicitFeedback = useImplicitFeedbackStore(s => s.feedback);
  const autoPlaySession = useAutoPlaySessionStore(s => s.session);
  const autoPlayedCount = autoPlaySession?.autoPlayedCount ?? 0;

  // 再生完了率トラッキング
  const prevSongRef = useRef<{
    id: number;
    progress: number;
    duration: number;
    source: 'manual' | 'auto' | 'discovery';
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
      const decision = useAutoQueueDecisionStore.getState().getLatestDecisionForSong(previous.id);
      if (decision) useAutoQueueBanditStore.getState().recordOutcome(decision.strategyArm, outcome);
    }
  };

  // 視聴履歴 + 暗黙的フィードバック
  useEffect(() => {
    if (!currentSong) {
      if (prevSongRef.current) finalizePreviousPlayback(prevSongRef.current);
      useProgressStore.getState().resetProgress();
      return;
    }

    if (!historyHydrated) return;

    // The persisted player queue is restored with sequence 0. It represents
    // the previous session, so do not append the same song again on app boot.
    // Waiting for hydration also prevents a race where the history snapshot
    // is still empty and the duplicate check cannot see the previous event.
    const recordPlayback = shouldRecordPlayback(
      historyHydrated,
      true,
      currentPlaybackSequence,
    );

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

    if (recordPlayback) {
      addToHistory(currentSong, currentPlaybackSource, currentPlaybackSequence);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentSong?.id, currentPlaybackSequence, historyHydrated]);

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
    queue,
    queueIndex,
    historyEntries,
    ratings,
    playlists,
    implicitFeedback,
    autoPlayedCount,
    adaptation: {
      autoCompletedCount: autoPlaySession?.autoCompletedCount ?? 0,
      autoSkippedCount: autoPlaySession?.autoSkippedCount ?? 0,
      consecutiveSkips: autoPlaySession?.consecutiveSkips ?? 0,
    },
    addManyToQueue,
  });

  return null;
}

function AppContent() {
  const currentSong = usePlayerStore(s => s.currentSong);

  useEffect(() => {
    document.title = formatDocumentTitle(currentSong);
  }, [currentSong]);

  return (
    <>
      <PlayerTracker />
      <MediaSession />
      <KeyboardShortcuts />
      {/* Keep the playback iframe outside route rendering and lazy-page suspension. */}
      <GlobalPlayer />
      <Routes>
        <Route element={<Layout />}>
          <Route path="/" element={<HomePage />} />
          <Route path="/watch" element={<WatchPage />} />
          <Route path="/history" element={<HistoryPage />} />
          <Route path="/favorites" element={<FavoritesPage />} />
          <Route path="/favorite-producers" element={<FavoriteProducersPage />} />
          <Route path="/playlists" element={<PlaylistPage />} />
          <Route path="/reports" element={<ReportsPage />} />
          <Route path="/chorus-highlights" element={<ChorusHighlightsPage />} />
          <Route path="/knowledge-map" element={<KnowledgeMapPage />} />
          <Route path="/settings/hidden-songs" element={<HiddenSongsPage />} />
          {/* 旧ルートの互換性 */}
          <Route path="/playing" element={<WatchPage />} />
        </Route>
      </Routes>
    </>
  );
}

export default function App() {
  return (
    <BrowserRouter basename={import.meta.env.BASE_URL.replace(/\/$/, '')}>
      <AppErrorBoundary>
        <AppContent />
      </AppErrorBoundary>
    </BrowserRouter>
  );
}
