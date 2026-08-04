import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { searchSongsBackend, refreshSearchRandomSeed } from '../search/searchBackendClient';
import type { Song } from '../types/vocadb';
import { usePlayerStore } from '../stores/playerStore';
import { useProgressStore } from '../stores/progressStore';
import { useRatingStore } from '../stores/ratingStore';
import { useUiStore } from '../stores/uiStore';
import StarRating from '../components/player/StarRating';

function formatTime(seconds?: number): string {
  if (seconds == null || !Number.isFinite(seconds)) return '--:--';
  return `${Math.floor(seconds / 60)}:${Math.floor(seconds % 60).toString().padStart(2, '0')}`;
}

export default function ChorusHighlightsPage() {
  const [candidates, setCandidates] = useState<Song[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState(false);
  const soughtSongId = useRef<number | null>(null);
  const advancedSongId = useRef<number | null>(null);

  const currentSong = usePlayerStore(state => state.currentSong);
  const queueIndex = usePlayerStore(state => state.queueIndex);
  const setQueue = usePlayerStore(state => state.setQueue);
  const next = usePlayerStore(state => state.next);
  const seekTo = usePlayerStore(state => state.seekTo);
  const progress = useProgressStore(state => state.progress);
  const duration = useProgressStore(state => state.duration);
  const getRating = useRatingStore(state => state.getRating);
  const setRating = useRatingStore(state => state.setRating);
  const openSaveToPlaylist = useUiStore(state => state.openSaveToPlaylist);

  const loadCandidates = useCallback(async () => {
    setLoading(true);
    setError(null);
    refreshSearchRandomSeed();
    try {
      const result = await searchSongsBackend({
        sort: 'Random',
        sortOrder: 'desc',
        start: 0,
        maxResults: 60,
        discoveryOnly: true,
        chorusOnly: true,
      });
      setCandidates(result.items.filter(song =>
        song.chorusStartSeconds != null
        && song.pvs?.some(pv => !pv.disabled && ['Youtube', 'NicoNicoDouga', 'SoundCloud'].includes(pv.service)),
      ));
    } catch {
      setError('サビ候補を読み込めませんでした。');
      setCandidates([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadCandidates(); }, [loadCandidates]);

  const candidateIds = useMemo(() => new Set(candidates.map(song => song.id)), [candidates]);
  const isHighlightSong = !!currentSong && candidateIds.has(currentSong.id);
  const startSeconds = isHighlightSong ? currentSong?.chorusStartSeconds ?? 0 : 0;
  const endSeconds = isHighlightSong
    ? Math.min(duration || currentSong?.lengthSeconds || startSeconds + 15, currentSong?.chorusEndSeconds ?? startSeconds + 15)
    : 0;

  useEffect(() => {
    if (!active || !currentSong || !isHighlightSong || duration <= 0) return;
    if (soughtSongId.current === currentSong.id) return;
    soughtSongId.current = currentSong.id;
    advancedSongId.current = null;
    seekTo(currentSong.chorusStartSeconds ?? 0);
  }, [active, currentSong, duration, isHighlightSong, seekTo]);

  useEffect(() => {
    if (!active || !currentSong || !isHighlightSong || endSeconds <= 0) return;
    if (progress < endSeconds - 0.2 || advancedSongId.current === currentSong.id) return;
    advancedSongId.current = currentSong.id;
    next();
  }, [active, currentSong, endSeconds, isHighlightSong, next, progress]);

  const startHighlights = () => {
    if (candidates.length === 0) return;
    soughtSongId.current = null;
    advancedSongId.current = null;
    setActive(true);
    setQueue(candidates, 0, true, 'discovery', '15秒サビハイライト');
  };

  const skip = () => {
    if (currentSong) advancedSongId.current = currentSong.id;
    next();
  };

  const elapsed = active && isHighlightSong ? Math.max(0, progress - startSeconds) : 0;
  const windowLength = Math.max(1, endSeconds - startSeconds || 15);
  const windowProgress = Math.min(100, elapsed / windowLength * 100);

  return (
    <main className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6" data-testid="chorus-highlights-page">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-fuchsia-300">Fast discovery</p>
          <h1 className="mt-1 text-2xl font-bold text-white">15秒サビハイライト</h1>
          <p className="mt-2 text-sm text-neutral-400">音源解析で推定したサビ候補だけを連続再生します。気になった曲はその場で保存・評価できます。</p>
        </div>
        <button type="button" className="btn-ghost rounded-lg px-3 py-2 text-sm" onClick={() => void loadCandidates()} disabled={loading}>
          候補を入れ替える
        </button>
      </div>

      {loading ? (
        <div className="rounded-2xl border border-white/[0.06] bg-white/[0.03] p-10 text-center text-neutral-400">サビ候補を選んでいます…</div>
      ) : error ? (
        <div className="rounded-2xl border border-red-400/20 bg-red-400/10 p-6 text-red-200">{error}</div>
      ) : candidates.length === 0 ? (
        <div className="rounded-2xl border border-white/[0.06] bg-white/[0.03] p-8 text-center text-neutral-400">
          解析済みのサビ候補がまだありません。音源解析pipelineの次回実行後に候補が追加されます。
        </div>
      ) : !active || !isHighlightSong ? (
        <section className="rounded-3xl border border-fuchsia-300/15 bg-gradient-to-br from-fuchsia-400/10 to-cyan-300/5 p-8 text-center">
          <div className="mx-auto mb-5 flex h-20 w-20 items-center justify-center rounded-full bg-fuchsia-400/15 text-3xl">♫</div>
          <p className="text-lg font-semibold text-white">{candidates.length}曲のサビ候補を準備しました</p>
          <p className="mt-2 text-sm text-neutral-400">再生開始後は15秒ごとに自動で次へ進みます。</p>
          <button type="button" className="mt-6 rounded-full bg-fuchsia-500 px-6 py-3 font-semibold text-white shadow-lg shadow-fuchsia-500/20" onClick={startHighlights}>
            ハイライトを開始
          </button>
        </section>
      ) : currentSong && (
        <section className="overflow-hidden rounded-3xl border border-white/[0.08] bg-neutral-900/80 shadow-2xl">
          <div className="grid md:grid-cols-[minmax(280px,0.9fr)_minmax(0,1.1fr)]">
            <div className="aspect-video bg-neutral-950 md:aspect-square">
              {currentSong.thumbUrl ? <img src={currentSong.thumbUrl} alt="" className="h-full w-full object-cover" /> : <div className="flex h-full items-center justify-center text-6xl text-neutral-700">♫</div>}
            </div>
            <div className="flex flex-col justify-center p-6 sm:p-8">
              <p className="text-xs text-fuchsia-300">{queueIndex + 1} / {candidates.length} ・ {formatTime(startSeconds)}から</p>
              <h2 className="mt-2 text-2xl font-bold text-white">{currentSong.name}</h2>
              <p className="mt-2 text-sm text-neutral-400">{currentSong.artistString}</p>
              {currentSong.isSelfCover && <span className="mt-3 w-fit rounded-full bg-fuchsia-400/15 px-2.5 py-1 text-xs font-semibold text-fuchsia-200">Self Cover</span>}

              <div className="mt-7">
                <div className="mb-2 flex justify-between text-xs text-neutral-500"><span>{formatTime(progress)}</span><span>15秒</span></div>
                <div className="h-2 overflow-hidden rounded-full bg-white/[0.08]"><div className="h-full rounded-full bg-gradient-to-r from-fuchsia-500 to-cyan-400 transition-[width]" style={{ width: `${windowProgress}%` }} /></div>
              </div>

              <div className="mt-7 flex flex-wrap items-center gap-3">
                <StarRating rating={getRating(currentSong.id)} onRate={rating => setRating(currentSong.id, rating)} />
                <button type="button" className="btn-ghost rounded-lg px-3 py-2 text-sm" onClick={() => openSaveToPlaylist(currentSong)}>保存</button>
                <button type="button" className="rounded-lg bg-white px-5 py-2 text-sm font-semibold text-black" onClick={skip}>スキップ</button>
              </div>
            </div>
          </div>
        </section>
      )}

      {candidates.length > 0 && (
        <div className="mt-6 flex gap-2 overflow-x-auto pb-2">
          {candidates.slice(Math.max(0, queueIndex + 1), Math.max(0, queueIndex + 7)).map(song => (
            <div key={song.id} className="w-36 flex-none rounded-xl border border-white/[0.06] bg-white/[0.03] p-2">
              <p className="truncate text-xs font-semibold text-neutral-200">{song.name}</p>
              <p className="mt-1 truncate text-[10px] text-neutral-500">{song.artistString}</p>
            </div>
          ))}
        </div>
      )}
    </main>
  );
}
