import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { BrowserRouter, Navigate, Routes, Route, useLocation } from 'react-router';
import Layout from './components/layout/Layout';
import KeyboardShortcuts from './components/player/KeyboardShortcuts';
import GlobalPlayer from './components/player/GlobalPlayer';
import { usePlayerStore } from './stores/playerStore';
import { useHistoryStore } from './stores/historyStore';
import { useProgressStore } from './stores/progressStore';
import { useImplicitFeedbackStore } from './stores/implicitFeedbackStore';
import { useAutoPlaySessionStore } from './stores/autoPlaySessionStore';
import { useAutoQueueDecisionStore } from './stores/autoQueueDecisionStore';
import { useAutoQueueBanditStore } from './stores/autoQueueBanditStore';
import AppErrorBoundary from './components/AppErrorBoundary';
import NotFoundPage from './components/layout/NotFoundPage';
import { DeferredBoundary } from './components/layout/RouteErrorBoundary';
import ToastHost from './components/ui/ToastHost';
import ConfirmHost from './components/ui/ConfirmHost';
import {
  formatDocumentTitle,
  pageDocumentTitle,
  watchLoadingDocumentTitle,
  watchUnavailableDocumentTitle,
} from './utils/documentTitle';
import { shouldRecordPlayback } from './utils/playbackHistory';
import { isWatchPath } from './utils/routes';
import { useLanguageStore } from './stores/languageStore';
import { loadRoute } from './routes/routeLoaders';
import type { WatchPageDocumentTitleState } from './pages/WatchPage';
import { useTranslate, useTranslateSourceText, type TranslationKey } from './i18n';

const PAGE_TITLE_KEYS: Readonly<Record<string, TranslationKey>> = {
  '/history': 'sidebarHistory',
  '/favorites': 'sidebarRatings',
  '/favorite-producers': 'sidebarFavoriteProducers',
  '/playlists': 'navPlaylists',
  '/reports': 'sidebarReports',
  '/chorus-highlights': 'sidebarChorus',
  '/knowledge-map': 'sidebarKnowledgeMap',
  '/sound-map': 'sidebarSoundMap',
};

// Page chunks are shared with the guide's hover preloading (routes/routeLoaders.ts), which also
// starts the entry page's download while App is being evaluated.
const HomePage = lazy(() => loadRoute('home'));
const WatchPage = lazy(() => loadRoute('watch'));
const PlaylistPage = lazy(() => loadRoute('playlists'));
const HistoryPage = lazy(() => loadRoute('history'));
const FavoritesPage = lazy(() => loadRoute('favorites'));
const FavoriteProducersPage = lazy(() => loadRoute('favoriteProducers'));
const ReportsPage = lazy(() => loadRoute('reports'));
const HiddenSongsPage = lazy(() => loadRoute('hiddenSongs'));
const ChorusHighlightsPage = lazy(() => loadRoute('chorusHighlights'));
const KnowledgeMapPage = lazy(() => loadRoute('knowledgeMap'));
const SoundMapPage = lazy(() => loadRoute('soundMap'));
// Not needed for the first paint: loaded right after it, outside the initial JavaScript (§1-12).
const AutoQueueRunner = lazy(() => import('./components/player/AutoQueueRunner'));
const MediaSession = lazy(() => import('./components/player/MediaSession'));

/** The old song page URL: /playing?v=… → /watch?v=… (replace, so Back skips it). */
function LegacyPlayingRedirect() {
  const { search } = useLocation();
  return <Navigate to={{ pathname: '/watch', search }} replace />;
}

/**
 * App - ルートコンポーネント
 *
 * BrowserRouter + Layout でSPA構成を実現。
 * GlobalPlayer はルートの外に常駐させ、ページを移っても再生が途切れない。
 */

function PlayerTracker() {
  const currentSong = usePlayerStore(s => s.currentSong);
  const currentPlaybackSource = usePlayerStore(s => s.currentPlaybackSource);
  const currentPlaybackSequence = usePlayerStore(s => s.playbackSequence);
  const progress = useProgressStore(s => s.progress);
  const duration = useProgressStore(s => s.duration);

  const addToHistory = useHistoryStore(s => s.addToHistory);
  const finalizeHistoryEntry = useHistoryStore(s => s.finalizeHistoryEntry);
  const historyHydrated = useHistoryStore(s => s.hasHydrated);

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

  return null;
}

function AppContent() {
  const tk = useTranslate();
  const t = useTranslateSourceText();
  const currentSong = usePlayerStore(s => s.currentSong);
  const language = useLanguageStore(s => s.language);
  const location = useLocation();
  const isWatchRoute = isWatchPath(location.pathname);
  const parsedRequestedSongId = isWatchRoute
    ? Number(new URLSearchParams(location.search).get('v'))
    : Number.NaN;
  const requestedSongId = Number.isSafeInteger(parsedRequestedSongId) && parsedRequestedSongId > 0
    ? parsedRequestedSongId
    : null;
  const [watchTitleState, setWatchTitleState] = useState<WatchPageDocumentTitleState | null>(null);
  const reportWatchTitleState = useCallback((state: WatchPageDocumentTitleState) => {
    setWatchTitleState(state);
  }, []);

  useEffect(() => {
    if (isWatchRoute && requestedSongId) {
      const state = watchTitleState?.songId === requestedSongId ? watchTitleState : null;
      if (state?.status === 'loaded') {
        document.title = formatDocumentTitle(state.song, language);
      } else if (state?.status === 'error') {
        document.title = watchUnavailableDocumentTitle(language);
      } else if (currentSong?.id === requestedSongId) {
        // Show the locally known song immediately while WatchPage refreshes its
        // page metadata, then replace it with the fetched page song.
        document.title = formatDocumentTitle(currentSong, language);
      } else {
        // A new tab can restore another tab's player state before its own URL
        // finishes loading. Never label that tab with the unrelated old song.
        document.title = watchLoadingDocumentTitle(language);
      }
      return;
    }

    const path = location.pathname.replace(/\/+$/, '') || '/';
    const key = PAGE_TITLE_KEYS[path];
    const name = key ? tk(key) : path === '/settings/hidden-songs' ? t('表示しない曲') : undefined;
    document.title = pageDocumentTitle(name, language);
  }, [currentSong, isWatchRoute, language, location.pathname, requestedSongId, t, tk, watchTitleState]);

  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);

  return (
    <>
      <PlayerTracker />
      <DeferredBoundary>
        <Suspense fallback={null}>
          <AutoQueueRunner />
          <MediaSession />
        </Suspense>
      </DeferredBoundary>
      <KeyboardShortcuts />
      {/* Keep the playback iframe outside route rendering and lazy-page suspension. */}
      <GlobalPlayer />
      <Routes>
        <Route element={<Layout />}>
          <Route path="/" element={<HomePage />} />
          <Route path="/watch" element={<WatchPage onDocumentTitleStateChange={reportWatchTitleState} />} />
          <Route path="/history" element={<HistoryPage />} />
          <Route path="/favorites" element={<FavoritesPage />} />
          <Route path="/favorite-producers" element={<FavoriteProducersPage />} />
          <Route path="/playlists" element={<PlaylistPage />} />
          <Route path="/reports" element={<ReportsPage />} />
          <Route path="/chorus-highlights" element={<ChorusHighlightsPage />} />
          <Route path="/knowledge-map" element={<KnowledgeMapPage />} />
          <Route path="/sound-map" element={<SoundMapPage />} />
          <Route path="/settings/hidden-songs" element={<HiddenSongsPage />} />
          {/* 旧ルートの互換性 */}
          <Route path="/playing" element={<LegacyPlayingRedirect />} />
          {/* Old links and typos: keep the frame and say so instead of an empty screen. */}
          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Routes>
      {/* After <Routes> so the toast live region comes after <main> in the DOM. */}
      <ToastHost />
      <ConfirmHost />
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
