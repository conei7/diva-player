import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { useSearchParams } from 'react-router';
import { fetchSoundMap, SoundMapRequestError, type SoundMapPoint, type SoundMapResponse } from '../api/soundMap';
import { getDemoSoundMap } from '../api/soundMapDemo';
import { fetchSoundMapPilot } from '../api/soundMapPilot';
import { getSongsByIds } from '../api/vocadb';
import { getPlayedSongIds } from '../services/historyDatabase';
import { useHiddenSongStore } from '../stores/hiddenSongStore';
import { usePlayerStore } from '../stores/playerStore';
import { useRatingStore } from '../stores/ratingStore';
import { useUiStore } from '../stores/uiStore';
import { clampSoundMapZoom, centerSoundMapOnPoint, fitSoundMapItems, visibleSoundMapItems, type SoundMapViewport } from '../utils/soundMap';
import { getRatedSongIds } from '../utils/ratedSongs';

function readId(value: string | null): number | null {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function pointClass(known: boolean, selected: boolean, origin: boolean): string {
  if (origin) return 'fill-cyan-300 stroke-white';
  if (selected) return 'fill-white stroke-cyan-300';
  return known ? 'fill-fuchsia-400 stroke-fuchsia-100' : 'fill-none stroke-neutral-400';
}

function mapErrorMessage(error: unknown): string {
  if (error instanceof SoundMapRequestError) {
    if (error.code === 'sound_map_unavailable') return '曲調マップの座標がまだ公開されていません。座標生成後に利用できます。';
    if (error.code === 'seed_not_mapped') return 'この曲は曲調マップにまだ含まれていません。別の起点を選んでください。';
    if (error.code === 'sound_map_dependency_unavailable') return '音響検索に接続できませんでした。少し待って再試行してください。';
    if (error.code === 'sound_map_pilot_missing' || error.code === 'sound_map_pilot_invalid') return error.message;
  }
  return '曲調マップを読み込めませんでした。データAPIへの接続を確認して再試行してください。';
}

export default function SoundMapPage() {
  const currentSong = usePlayerStore(state => state.currentSong);
  const ratings = useRatingStore(state => state.ratings);
  const hiddenSongs = useHiddenSongStore(state => state.hiddenSongs);
  const hiddenIds = useMemo(
    () => new Set(Object.keys(hiddenSongs).map(Number).filter(id => Number.isInteger(id) && id > 0)),
    [hiddenSongs],
  );
  const openSongDetail = useUiStore(state => state.openSongDetail);
  const openSaveToPlaylist = useUiStore(state => state.openSaveToPlaylist);
  const playSong = usePlayerStore(state => state.playSong);
  const [searchParams, setSearchParams] = useSearchParams();
  const [result, setResult] = useState<SoundMapResponse | null>(null);
  const [fallbackSeedId, setFallbackSeedId] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [retryKey, setRetryKey] = useState(0);
  const [explorationHistory, setExplorationHistory] = useState<number[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(() => readId(searchParams.get('selectedSongId')));
  const [viewport, setViewport] = useState<SoundMapViewport>(() => ({
    zoom: clampSoundMapZoom(Number(searchParams.get('zoom')) || 1),
    centerX: Number(searchParams.get('centerX')) || 0,
    centerY: Number(searchParams.get('centerY')) || 0,
  }));
  const requestRevision = useRef(0);
  const demoMode = import.meta.env.DEV && searchParams.get('demo') === '1';
  const pilotMode = import.meta.env.DEV && searchParams.get('pilot') === '1';
  const localPreviewMode = demoMode || pilotMode;
  const seedId = readId(searchParams.get('seedSongId')) ?? fallbackSeedId ?? currentSong?.id ?? null;
  const mapVersion = searchParams.get('mapVersion') || undefined;
  const [playedIds, setPlayedIds] = useState<Set<number>>(new Set());
  const knownIds = useMemo(() => {
    const ids = new Set(getRatedSongIds(ratings));
    playedIds.forEach(id => ids.add(id));
    return ids;
  }, [playedIds, ratings]);
  const displayKnownIds = useMemo(() => {
    if (!demoMode || !result) return knownIds;
    const ids = new Set(knownIds);
    result.items.forEach((point, index) => {
      if (index > 0 && index % 4 === 0) ids.add(point.songId);
    });
    return ids;
  }, [demoMode, knownIds, result]);
  useEffect(() => {
    getPlayedSongIds().then(setPlayedIds).catch(() => setPlayedIds(new Set()));
  }, [currentSong?.id]);
  useEffect(() => {
    if (readId(searchParams.get('seedSongId')) || fallbackSeedId || !currentSong?.id) return;
    const next = new URLSearchParams(searchParams);
    next.set('seedSongId', String(currentSong.id));
    setSearchParams(next, { replace: true });
  }, [currentSong?.id, fallbackSeedId, searchParams, setSearchParams]);

  useEffect(() => {
    if (readId(searchParams.get('seedSongId')) || fallbackSeedId || currentSong?.id) return;
    getPlayedSongIds().then(ids => {
      const first = [...ids][0] ?? null;
      if (first) setFallbackSeedId(first);
    }).catch(() => undefined);
  }, [currentSong?.id, fallbackSeedId, searchParams]);

  useEffect(() => {
    if (!seedId) return;
    const revision = ++requestRevision.current;
    const controller = new AbortController();
    setLoading(true);
    setError('');
    const request = demoMode
      ? Promise.resolve(getDemoSoundMap(seedId, mapVersion ?? 'demo-v1'))
      : pilotMode
        ? fetchSoundMapPilot(seedId, controller.signal)
        : fetchSoundMap(seedId, { mapVersion, limit: 120, signal: controller.signal });
    request
      .then(next => {
        if (revision !== requestRevision.current) return;
        setResult(next);
        setSelectedId(readId(searchParams.get('selectedSongId')) ?? next.origin.songId);
        if (!searchParams.has('centerX') && !searchParams.has('centerY')) {
          setViewport(fitSoundMapItems(next.items));
        }
        if (!mapVersion || mapVersion !== next.mapVersion || (pilotMode && seedId !== next.origin.songId)) {
          const params = new URLSearchParams(searchParams);
          params.set('mapVersion', next.mapVersion);
          params.set('seedSongId', String(pilotMode ? next.origin.songId : seedId));
          setSearchParams(params, { replace: true });
        }
      })
      .catch(requestError => {
        if (revision === requestRevision.current && !(requestError instanceof Error && requestError.name === 'AbortError')) {
          setError(mapErrorMessage(requestError));
        }
      })
      .finally(() => { if (revision === requestRevision.current) setLoading(false); });
    return () => controller.abort();
  }, [demoMode, mapVersion, pilotMode, retryKey, searchParams, seedId, setSearchParams]);

  const items = useMemo(
    () => result ? visibleSoundMapItems(result.items, hiddenIds) : [],
    [hiddenIds, result],
  );
  const selected = items.find(item => item.songId === selectedId) ?? result?.origin ?? null;
  const selectPoint = (point: SoundMapPoint) => {
    setSelectedId(point.songId);
    const params = new URLSearchParams(searchParams);
    params.set('selectedSongId', String(point.songId));
    setSearchParams(params, { replace: true });
  };
  const updateViewport = (next: SoundMapViewport) => {
    setViewport(next);
    const params = new URLSearchParams(searchParams);
    params.set('zoom', String(next.zoom));
    params.set('centerX', next.centerX.toFixed(4));
    params.set('centerY', next.centerY.toFixed(4));
    setSearchParams(params, { replace: true });
  };
  const setOrigin = (point: SoundMapPoint) => {
    if (seedId === point.songId) return;
    if (seedId && seedId !== point.songId) {
      setExplorationHistory(history => [...history, seedId].slice(-20));
    }
    const params = new URLSearchParams(searchParams);
    params.set('seedSongId', String(point.songId));
    params.delete('selectedSongId');
    params.delete('centerX');
    params.delete('centerY');
    setSearchParams(params);
    setViewport(centerSoundMapOnPoint(point, 1));
  };
  const goBackToPreviousExploration = () => {
    const previous = explorationHistory.at(-1);
    if (!previous) return;
    setExplorationHistory(history => history.slice(0, -1));
    const params = new URLSearchParams(searchParams);
    params.set('seedSongId', String(previous));
    params.delete('selectedSongId');
    params.delete('centerX');
    params.delete('centerY');
    setSearchParams(params);
  };
  const focusOrigin = () => result && updateViewport(centerSoundMapOnPoint(result.origin, Math.max(1, viewport.zoom)));
  const loadSong = useCallback(async (songId: number) => (await getSongsByIds([songId]))[0], []);

  const playSelected = async () => {
    if (!selected) return;
    const song = await loadSong(selected.songId);
    if (song) playSong(song, true);
  };
  const saveSelected = async () => {
    if (!selected) return;
    const song = await loadSong(selected.songId);
    if (song) openSaveToPlaylist(song);
  };
  const showDetails = async () => {
    if (!selected) return;
    const song = await loadSong(selected.songId);
    if (song) openSongDetail(song);
  };

  return (
    <main className="mx-auto w-full max-w-7xl px-3 py-4 pb-32 sm:px-6 sm:py-6" data-testid="sound-map-page">
      <div className="mb-5 max-w-3xl">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-cyan-300">Sound Map</p>
        <h1 className="mt-1 text-2xl font-bold text-white sm:text-3xl">曲調マップ</h1>
        <p className="mt-2 text-sm leading-6 text-neutral-400">似た音響特徴の曲ほど近くに表示されます。軸に意味のある単位はなく、点の近さだけを目安に探索します。</p>
        {!localPreviewMode && currentSong && <p className="mt-3 text-xs text-cyan-200">再生中: {currentSong.name}</p>}
        {demoMode && <p className="mt-3 rounded-lg bg-cyan-300/10 px-3 py-2 text-xs text-cyan-100">画面確認用デモです。点の選択・ズーム・起点変更を試せます。</p>}
        {pilotMode && <p className="mt-3 rounded-lg bg-emerald-300/10 px-3 py-2 text-xs text-emerald-100">実データpilotです。Qdrantの音響ベクトルとPostgreSQLの曲名から生成した小規模マップを表示しています。</p>}
      </div>

      {!seedId ? (
        <section className="rounded-2xl border border-white/[0.08] bg-white/[0.03] p-6 text-sm text-neutral-300">
          曲を再生するか、履歴のある曲から曲調マップを開いてください。
        </section>
      ) : loading && !result ? (
        <div className="rounded-3xl border border-white/[0.06] bg-white/[0.03] py-24 text-center text-neutral-400" aria-busy="true">音響特徴と座標を読み込んでいます…</div>
      ) : error && !result ? (
        <section className="rounded-2xl border border-red-400/20 bg-red-400/10 p-6 text-red-100" role="alert">
          <p>{error}</p>
          <button type="button" onClick={() => setRetryKey(key => key + 1)} className="mt-4 rounded-lg bg-white px-4 py-2 text-sm font-semibold text-black">再試行</button>
        </section>
      ) : result ? (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <section className="overflow-hidden rounded-2xl border border-white/[0.08] bg-neutral-950 p-2 sm:p-3">
            {error && <p className="mb-2 rounded-lg bg-amber-400/10 px-2 py-1.5 text-xs text-amber-100" role="alert">{error} 前回のマップを表示しています。</p>}
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2 px-1 text-xs text-neutral-400">
              <span>起点: <strong className="text-white">{result.origin.name}</strong></span>
              <span>{result.coordinateCount.toLocaleString()}曲 · {result.method}</span>
            </div>
            <SoundMapCanvas items={items} knownIds={displayKnownIds} result={result} selectedId={selectedId} viewport={viewport} onSelect={selectPoint} />
            {result.state !== 'ready' && <p className="mt-2 px-1 text-xs text-amber-200">{result.state === 'no_audio' ? '起点の音響特徴がないため、座標だけを表示しています。' : '近い曲の候補がまだマップにありません。'}</p>}
            <div className="mt-2 flex flex-wrap items-center gap-2 px-1">
              <button type="button" className="btn-ghost rounded-lg px-3 py-2 text-xs" onClick={() => updateViewport({ ...viewport, zoom: clampSoundMapZoom(viewport.zoom - 0.35) })}>−</button>
              <span className="min-w-14 text-center text-xs text-neutral-400">{Math.round(viewport.zoom * 100)}%</span>
              <button type="button" className="btn-ghost rounded-lg px-3 py-2 text-xs" onClick={() => updateViewport({ ...viewport, zoom: clampSoundMapZoom(viewport.zoom + 0.35) })}>＋</button>
              <button type="button" className="btn-ghost rounded-lg px-3 py-2 text-xs" onClick={focusOrigin}>起点を表示</button>
              <button type="button" className="btn-ghost rounded-lg px-3 py-2 text-xs disabled:cursor-not-allowed disabled:opacity-40" onClick={goBackToPreviousExploration} disabled={explorationHistory.length === 0}>前の探索に戻る</button>
              <span className="ml-auto text-[11px] text-neutral-500">◆ 起点 · ● 再生/履歴あり · ○ 未再生</span>
            </div>
          </section>
          <SoundMapDetails
            selected={selected}
            neighbors={items.filter(item => item.songId !== result.origin.songId).slice(0, 8)}
            selectedId={selectedId}
            currentSong={localPreviewMode ? null : currentSong}
            actionsDisabled={localPreviewMode}
            onSelect={selectPoint}
            onSelectOrigin={setOrigin}
            onPlay={playSelected}
            onSave={saveSelected}
            onDetails={showDetails}
          />
        </div>
      ) : null}
    </main>
  );
}

function SoundMapCanvas({ items, knownIds, result, selectedId, viewport, onSelect }: {
  items: SoundMapPoint[];
  knownIds: ReadonlySet<number>;
  result: SoundMapResponse;
  selectedId: number | null;
  viewport: SoundMapViewport;
  onSelect: (point: SoundMapPoint) => void;
}) {
  const viewWidth = 2 / viewport.zoom;
  const viewHeight = 2 / viewport.zoom;
  const viewX = viewport.centerX - viewWidth / 2;
  const viewY = viewport.centerY - viewHeight / 2;
  const selectNearestPoint = (event: ReactMouseEvent<SVGSVGElement>) => {
    const matrix = event.currentTarget.getScreenCTM();
    if (!matrix) return;
    const cursor = event.currentTarget.createSVGPoint();
    cursor.x = event.clientX;
    cursor.y = event.clientY;
    const mapPosition = cursor.matrixTransform(matrix.inverse());
    let nearest: SoundMapPoint | null = null;
    let nearestDistance = Number.POSITIVE_INFINITY;
    for (const point of items) {
      const distance = Math.hypot(point.x - mapPosition.x, point.y - mapPosition.y);
      if (distance < nearestDistance) {
        nearest = point;
        nearestDistance = distance;
      }
    }
    if (nearest && nearestDistance <= 0.08 / viewport.zoom) onSelect(nearest);
  };
  return (
    <div className="relative h-[420px] w-full overflow-hidden rounded-xl bg-[radial-gradient(circle_at_center,rgba(34,211,238,.1),rgba(10,10,12,1)_70%)] sm:h-[clamp(340px,calc(100vh-24rem),520px)]" data-testid="sound-map-canvas">
      <svg className="h-full w-full cursor-crosshair" viewBox={`${viewX} ${viewY} ${viewWidth} ${viewHeight}`} role="img" aria-label="曲調マップ。点を選択すると詳細を表示します。" preserveAspectRatio="xMidYMid meet" onClick={selectNearestPoint}>
        {items.map(point => {
          const origin = point.songId === result.origin.songId;
          const selected = point.songId === selectedId;
          return (
            <g
              key={point.songId}
              data-song-id={point.songId}
              transform={`translate(${point.x} ${point.y})`}
              onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') onSelect(point); }}
              role="button"
              aria-label={`${point.name} / ${point.artistString}`}
              tabIndex={0}
              className="cursor-pointer"
            >
              <g transform={`scale(${1 / viewport.zoom})`}>
                {selected && <circle r={0.036} fill="none" stroke="white" strokeWidth={0.008} opacity=".9" />}
                <circle r={origin ? 0.028 : 0.018} className={pointClass(knownIds.has(point.songId), selected, origin)} strokeWidth={0.006} />
                {origin && <path d="M0,-0.052 L0.052,0 L0,0.052 L-0.052,0 Z" className="fill-cyan-300 stroke-white" strokeWidth=".006" />}
              </g>
              <title>{point.name} / {point.artistString}</title>
            </g>
          );
        })}
      </svg>
      {items.length === 0 && <div className="absolute inset-0 flex items-center justify-center text-sm text-neutral-500">表示できる曲がありません</div>}
    </div>
  );
}

function SoundMapDetails({ selected, neighbors, selectedId, currentSong, actionsDisabled, onSelect, onSelectOrigin, onPlay, onSave, onDetails }: {
  selected: SoundMapPoint | null;
  neighbors: SoundMapPoint[];
  selectedId: number | null;
  currentSong: ReturnType<typeof usePlayerStore.getState>['currentSong'];
  actionsDisabled: boolean;
  onSelect: (point: SoundMapPoint) => void;
  onSelectOrigin: (point: SoundMapPoint) => void;
  onPlay: () => void;
  onSave: () => void;
  onDetails: () => void;
}) {
  if (!selected) return <section className="rounded-2xl border border-white/[0.08] bg-white/[0.03] p-5 text-sm text-neutral-400">点を選択してください。</section>;
  const playing = currentSong?.id === selected.songId;
  return (
    <section className="rounded-2xl border border-white/[0.08] bg-white/[0.03] p-5">
      <p className="text-xs font-semibold uppercase tracking-[0.16em] text-cyan-300">選択中</p>
      <h2 className="mt-2 text-lg font-bold text-white" data-testid="sound-map-selected-title">{selected.name}</h2>
      <p className="mt-1 text-sm text-neutral-400">{selected.artistString || 'アーティスト情報なし'}</p>
      {playing && <p className="mt-3 text-xs text-cyan-200">現在再生中</p>}
      {selected.similarity != null && <p className="mt-3 text-xs text-neutral-500">音響類似度 {(selected.similarity * 100).toFixed(1)}%</p>}
      {actionsDisabled && <p className="mt-3 text-xs text-neutral-500">再生・保存・詳細は実データ接続後に利用できます。</p>}
      <div className="mt-5 grid grid-cols-2 gap-2">
        <button type="button" disabled={actionsDisabled} className="rounded-lg bg-cyan-300 px-3 py-2 text-sm font-semibold text-black disabled:cursor-not-allowed disabled:opacity-35" onClick={onPlay}>再生</button>
        <button type="button" className="btn-ghost rounded-lg px-3 py-2 text-sm" onClick={() => onSelectOrigin(selected)}>この曲の近くを探す</button>
        <button type="button" disabled={actionsDisabled} className="btn-ghost rounded-lg px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-35" onClick={onSave}>保存</button>
        <button type="button" disabled={actionsDisabled} className="btn-ghost rounded-lg px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-35" onClick={onDetails}>詳細</button>
      </div>
      {neighbors.length > 0 && (
        <div className="mt-6 border-t border-white/[0.08] pt-4">
          <p className="text-xs font-semibold text-neutral-400">近くの曲</p>
          <div className="mt-2 space-y-1">
            {neighbors.map(point => (
              <button
                key={point.songId}
                type="button"
                onClick={() => onSelect(point)}
                className={`block w-full rounded-lg px-2.5 py-2 text-left text-xs transition ${point.songId === selectedId ? 'bg-white/[0.12] text-white' : 'text-neutral-400 hover:bg-white/[0.06] hover:text-white'}`}
              >
                <span className="block truncate">{point.name}</span>
                <span className="mt-0.5 block truncate text-[10px] text-neutral-500">{point.artistString || 'アーティスト情報なし'}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
