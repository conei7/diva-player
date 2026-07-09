import { useEffect, useRef } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Layout from './components/layout/Layout';
import HomePage from './pages/HomePage';
import WatchPage from './pages/WatchPage';
import PlaylistPage from './pages/PlaylistPage';
import HistoryPage from './pages/HistoryPage';
import FavoritesPage from './pages/FavoritesPage';
import MediaSession from './components/player/MediaSession';
import KeyboardShortcuts from './components/player/KeyboardShortcuts';
import { usePlayerStore } from './stores/playerStore';
import { useHistoryStore } from './stores/historyStore';
import { useRatingStore } from './stores/ratingStore';
import { useProgressStore } from './stores/progressStore';
import { usePlaylistStore } from './stores/playlistStore';
import { useImplicitFeedbackStore } from './stores/implicitFeedbackStore';
import {
  getRecommendedSongs,
  getAudioSimilarSongs,
  getSongsByProducerFromBackend,
} from './api/vocadb';
import type { Song } from './types/vocadb';
import {
  buildPlaylistSongSet,
  getPlaylistSongs,
  rankKnownSongs,
  scoreQueueCandidates,
  uniqueSongsById,
  weightedShuffleByScore,
} from './utils/recommendationScoring';

/**
 * App - ルートコンポーネント
 * 
 * BrowserRouter + Layout でSPA構成を実現。
 * ページ遷移してもLayout内のPlayerBarは維持され、
 * 音楽再生が途切れない。
 */

/** フィッシャー–イェーツシャッフル */
/**
 * フロントエンドMMR: 時間減衰ペナルティ + プレイリスト曲ブースト
 * 
 * 候補曲リストに対してスコアリングを行い、より多様で好みに合った結果を返す。
 * - 直近数時間以内に再生した曲 → 強いペナルティ（排除に近い）
 * - 数時間〜1日経過 → 弱いペナルティ（たまに出る）
 * - 1日以上経過 → ペナルティなし
 * - プレイリストに入っている曲 → ブースト（既知の安心感ミックス）
 */
function applyFrontendMMR(
  candidates: Song[],
  historyEntries: { song: Song; playedAt: number }[],
  playlistSongIds: Set<number>,
  existingIds: Set<number>,
): Song[] {
  const now = Date.now();
  const ONE_HOUR = 60 * 60 * 1000;

  // 履歴からsongIdごとの最後の再生時刻をマッピング
  const lastPlayedMap = new Map<number, number>();
  for (const entry of historyEntries) {
    const existing = lastPlayedMap.get(entry.song.id);
    if (!existing || entry.playedAt > existing) {
      lastPlayedMap.set(entry.song.id, entry.playedAt);
    }
  }

  // スコアリング
  const scored = candidates
    .filter(s => !existingIds.has(s.id))
    .map(song => {
      let score = 1.0;

      // 時間減衰ペナルティ
      const lastPlayed = lastPlayedMap.get(song.id);
      if (lastPlayed) {
        const hoursAgo = (now - lastPlayed) / ONE_HOUR;
        if (hoursAgo < 1) {
          score *= 0.0; // 1時間以内 → 完全排除
        } else if (hoursAgo < 3) {
          score *= 0.1; // 1〜3時間 → ほぼ排除
        } else if (hoursAgo < 12) {
          score *= 0.5; // 3〜12時間 → 半減
        } else if (hoursAgo < 24) {
          score *= 0.8; // 12〜24時間 → 弱いペナルティ
        }
        // 24時間以上 → ペナルティなし
      }

      // プレイリスト曲ブースト
      if (playlistSongIds.has(song.id)) {
        score *= 1.3;
      }

      return { song, score };
    });

  // スコア順にソートし、上位にランダム性を持たせる
  scored.sort((a, b) => b.score - a.score);

  // スコアが0の曲は除外、残りをそのまま返す
  return scored.filter(s => s.score > 0).map(s => s.song);
}

function PlayerTracker() {
  const currentSong = usePlayerStore(s => s.currentSong);
  const rootSeed = usePlayerStore(s => s.rootSeed);
  const mixMode = usePlayerStore(s => s.mixMode);
  const queue = usePlayerStore(s => s.queue);
  const queueIndex = usePlayerStore(s => s.queueIndex);
  const addManyToQueue = usePlayerStore(s => s.addManyToQueue);
  const currentPlaybackSource = usePlayerStore(s => s.currentPlaybackSource);
  const progress = useProgressStore(s => s.progress);
  const duration = useProgressStore(s => s.duration);
  
  const { addToHistory, entries: historyEntries } = useHistoryStore();
  const { ratings } = useRatingStore();
  const { playlists } = usePlaylistStore();
  const implicitFeedback = useImplicitFeedbackStore(s => s.feedback);
  const fetchingForRef = useRef<number | null>(null);
  const ratingsRef = useRef(ratings);
  ratingsRef.current = ratings;
  const implicitFeedbackRef = useRef(implicitFeedback);
  implicitFeedbackRef.current = implicitFeedback;

  // 再生完了率トラッキング
  const prevSongRef  = useRef<{ id: number; progress: number; duration: number; source: 'manual' | 'auto' } | null>(null);
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
      useImplicitFeedbackStore.getState().recordPlayback(id, p, d, prevSongRef.current.source);
    }

    prevSongRef.current = {
      id: currentSong.id,
      progress: progressRef.current,
      duration: durationRef.current,
      source: currentPlaybackSource,
    };

    addToHistory(currentSong, currentPlaybackSource);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentSong?.id]);

  // progress/duration を prevSongRef に反映
  useEffect(() => {
    if (prevSongRef.current && currentSong && prevSongRef.current.id === currentSong.id) {
      prevSongRef.current = { id: currentSong.id, progress, duration, source: currentPlaybackSource };
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [progress, duration]);

  // 自動キュー: キューの残りが少なくなったら推薦曲を自動追加
  // Root Seed + ミックスモード + フロントエンドMMR を適用
  useEffect(() => {
    if (!currentSong) return;
    if (fetchingForRef.current === currentSong.id) return;

    const remaining = queue.length - 1 - queueIndex;
    if (remaining > 2) return;

    const songId = currentSong.id;
    fetchingForRef.current = songId;
    const existingIds = new Set(queue.map(s => s.id));

    // Root Seedが設定されていれば、現在の曲とRoot Seedの両方から候補を取得
    const seedId = rootSeed?.id ?? songId;
    const randomOffset = Math.floor(Math.random() * 20);

    // ミックスモードに応じてAPIを切り替え
    const fetchCandidates = async (): Promise<Song[]> => {
      switch (mixMode) {
        case 'deep':
          return getAudioSimilarSongs(songId, 40, randomOffset);
        case 'producer': {
          const producerIds = (currentSong.artists ?? [])
            .filter(a => a.categories?.includes('Producer'))
            .map(a => a.artist?.id)
            .filter((id): id is number => id !== undefined);
          return getSongsByProducerFromBackend(songId, producerIds, 40, randomOffset);
        }
        case 'balanced':
        default: {
          // Root Seedと現在の曲が異なる場合、両方から候補を取得してマージ
          if (seedId !== songId) {
            const [fromSeed, fromCurrent] = await Promise.all([
              getRecommendedSongs(seedId, 30, 0.0, ratingsRef.current, randomOffset),
              getRecommendedSongs(songId, 30, 0.0, ratingsRef.current, randomOffset),
            ]);
            // マージ: Root Seed由来を優先しつつ重複除去
            const seen = new Set<number>();
            const merged: Song[] = [];
            for (const s of [...fromSeed, ...fromCurrent]) {
              if (!seen.has(s.id)) {
                seen.add(s.id);
                merged.push(s);
              }
            }
            return merged;
          }
          return getRecommendedSongs(songId, 60, 0.0, ratingsRef.current, randomOffset);
        }
      }
    };

    // プレイリストに含まれる全曲IDのセットを構築
    const playlistSongIds = buildPlaylistSongSet(playlists);
    const playlistSongs = getPlaylistSongs(playlists);

    fetchCandidates()
      .then(candidates => {
        // フロントエンドMMRを適用: 時間減衰ペナルティ + プレイリスト曲ブースト
        const filteredCandidates = applyFrontendMMR(candidates, historyEntries, playlistSongIds, existingIds);
        const knownCandidates = rankKnownSongs(
          historyEntries,
          playlistSongs,
          ratingsRef.current,
          existingIds,
          implicitFeedbackRef.current,
        ).map(item => item.song);
        const sessionProgress = queue.length > 0 ? Math.min(1, queueIndex / queue.length) : 0;
        const knownLimit = Math.round(18 - sessionProgress * 10);
        const mixedCandidates = uniqueSongsById([
          ...knownCandidates.slice(0, Math.max(6, knownLimit)),
          ...filteredCandidates,
        ]);
        const scored = scoreQueueCandidates(
          mixedCandidates,
          historyEntries,
          playlistSongIds,
          ratingsRef.current,
          existingIds,
          implicitFeedbackRef.current,
        );
        const topScored = scored.slice(0, 80);
        // シャッフルして上位40件をキューに追加
        const newSongs = weightedShuffleByScore(topScored, item => item.score)
          .map(item => item.song)
          .slice(0, 40);
        addManyToQueue(newSongs, 'auto');
        if (fetchingForRef.current === songId) {
          fetchingForRef.current = null;
        }
      })
      .catch(() => {
        if (fetchingForRef.current === songId) {
          fetchingForRef.current = null;
        }
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentSong?.id, queueIndex, queue.length]);

  return null;
}

function AppContent() {
  return (
    <>
      <PlayerTracker />
      <MediaSession />
      <KeyboardShortcuts />
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
    <BrowserRouter basename={import.meta.env.BASE_URL.replace(/\/$/, '')}>
      <AppContent />
    </BrowserRouter>
  );
}
