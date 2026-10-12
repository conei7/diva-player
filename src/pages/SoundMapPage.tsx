import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router';
import { fetchSoundMap, SoundMapRequestError, type SoundMapPoint, type SoundMapResponse } from '../api/soundMap';
import { getDemoSoundMap } from '../api/soundMapDemo';
import { fetchSoundMapPilot } from '../api/soundMapPilot';
import { getSongsByIds } from '../api/vocadb';
import { MOBILE_MEDIA_QUERY, useMediaQuery } from '../hooks/useMediaQuery';
import { translateSourceText, useTranslateSourceText } from '../i18n';
import { getPlayedSongIds } from '../services/historyDatabase';
import { useHiddenSongStore } from '../stores/hiddenSongStore';
import { useHistoryStore } from '../stores/historyStore';
import { useLanguageStore, type AppLanguage } from '../stores/languageStore';
import { usePlayerStore } from '../stores/playerStore';
import { usePlaylistStore } from '../stores/playlistStore';
import { useRatingStore } from '../stores/ratingStore';
import { showToast } from '../stores/toastStore';
import { useUiStore } from '../stores/uiStore';
import type { Song } from '../types/vocadb';
import { getRatedSongIds } from '../utils/ratedSongs';
import { watchPath } from '../utils/routes';
import {
  DEFAULT_SOUND_MAP_VIEWPORT,
  centerSoundMapOnPoint,
  clampSoundMapZoom,
  fitSoundMapItems,
  pickSoundMapFallbackSeed,
  pushSoundMapTrail,
  readSoundMapTrail,
  visibleSoundMapItems,
  type SoundMapViewport,
} from '../utils/soundMap';
import { changeSoundMapAxes, readSoundMapAxes } from '../utils/soundMapAxes';
import { Chip } from '../components/ui/Chip';
import EmptyState, { type EmptyStateAction } from '../components/ui/EmptyState';
import InfoTip from '../components/ui/InfoTip';
import InlineNotice from '../components/ui/InlineNotice';
import { PageHeader, PageShell } from '../components/ui/PageHeader';
import { SkeletonBlock, SkeletonListRow } from '../components/ui/Skeleton';
import { ErrorIcon, ScatterIcon } from '../components/ui/icons';
import SoundMapAxisForm from '../components/discovery/SoundMapAxisForm';
import SoundMapCanvas from '../components/discovery/SoundMapCanvas';
import SoundMapGuide from '../components/discovery/SoundMapGuide';
import SoundMapNearby from '../components/discovery/SoundMapNearby';
import SoundMapOriginMenu from '../components/discovery/SoundMapOriginMenu';
import SoundMapSelectionCard, { SoundMapSelectionBar } from '../components/discovery/SoundMapSelection';
import SoundMapSettings from '../components/discovery/SoundMapSettings';
import { placeholderSong, useSongsById } from '../components/discovery/discoverySongs';

const SOUND_MAP_GUIDE_STORAGE_KEY = 'diva_sound_map_guide_dismissed_v1';
/** Nearby rows shown before 「もっと見る」. */
const NEARBY_INITIAL_COUNT = 20;

type SoundMapErrorKind = 'unavailable' | 'not_mapped' | 'features_unavailable' | 'dependency' | 'pilot' | 'generic';

interface SoundMapError {
  kind: SoundMapErrorKind;
  /** Developer-only message of the local pilot file. */
  message?: string;
}

function readSoundMapGuideDismissed(): boolean {
  try {
    return window.localStorage.getItem(SOUND_MAP_GUIDE_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function readId(value: string | null): number | null {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** The viewport written in the URL (zoom / center), or null when the map should fit its songs. */
function readViewport(params: URLSearchParams): SoundMapViewport | null {
  if (!params.has('centerX') && !params.has('centerY')) return null;
  return {
    zoom: clampSoundMapZoom(Number(params.get('zoom')) || 1),
    centerX: Number(params.get('centerX')) || 0,
    centerY: Number(params.get('centerY')) || 0,
  };
}

function classifyError(error: unknown): SoundMapError {
  if (error instanceof SoundMapRequestError) {
    if (error.code === 'sound_map_unavailable') return { kind: 'unavailable' };
    if (error.code === 'seed_not_mapped') return { kind: 'not_mapped' };
    if (error.code === 'sound_map_features_unavailable') return { kind: 'features_unavailable' };
    if (error.code === 'sound_map_dependency_unavailable') return { kind: 'dependency' };
    if (error.code === 'sound_map_pilot_missing' || error.code === 'sound_map_pilot_invalid') {
      return { kind: 'pilot', message: error.message };
    }
  }
  return { kind: 'generic' };
}

interface RequestKeyParts {
  demo: boolean;
  pilot: boolean;
  seedId: number;
  mapVersion: string | undefined;
  featureMode: boolean;
  axisX: number;
  axisY: number;
  retryKey: number;
}

/** Identifies one map request; the map version we just wrote to the URL must not fetch again. */
function requestKey(parts: RequestKeyParts): string {
  return JSON.stringify([
    parts.demo,
    parts.pilot,
    parts.seedId,
    parts.mapVersion ?? null,
    parts.featureMode,
    parts.featureMode ? parts.axisX : null,
    parts.featureMode ? parts.axisY : null,
    parts.retryKey,
  ]);
}

function formatMapDate(iso: string, language: AppLanguage): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat(
    language === 'ja' ? 'ja-JP' : 'en-US',
    language === 'ja' ? { year: 'numeric', month: 'numeric', day: 'numeric' } : { year: 'numeric', month: 'short', day: 'numeric' },
  ).format(date);
}

/** Starting song when the URL has none and nothing is playing (history → ratings → playlists). */
async function findFallbackSeed(): Promise<number | null> {
  const excludedIds = new Set(Object.keys(useHiddenSongStore.getState().hiddenSongs).map(Number));
  try {
    await useHistoryStore.getState().initializeHistory();
  } catch {
    // The listening history is optional here.
  }
  const fromHistory = pickSoundMapFallbackSeed({
    lastPlayedAtBySongId: useHistoryStore.getState().lastPlayedAtBySongId,
    excludedIds,
  });
  if (fromHistory) return fromHistory;
  const playedIds = await getPlayedSongIds().catch(() => new Set<number>());
  return pickSoundMapFallbackSeed({
    playedIds,
    ratings: useRatingStore.getState().ratings,
    playlistSongIds: usePlaylistStore.getState().playlists.flatMap(playlist => playlist.songs.map(song => song.id)),
    excludedIds,
  });
}

export default function SoundMapPage() {
  const t = useTranslateSourceText();
  const language = useLanguageStore(state => state.language);
  const currentSong = usePlayerStore(state => state.currentSong);
  const playSong = usePlayerStore(state => state.playSong);
  const ratings = useRatingStore(state => state.ratings);
  const hiddenSongs = useHiddenSongStore(state => state.hiddenSongs);
  const hiddenIds = useMemo(
    () => new Set(Object.keys(hiddenSongs).map(Number).filter(id => Number.isInteger(id) && id > 0)),
    [hiddenSongs],
  );
  const openSongDetail = useUiStore(state => state.openSongDetail);
  const openSaveToPlaylist = useUiStore(state => state.openSaveToPlaylist);
  const isMobile = useMediaQuery(MOBILE_MEDIA_QUERY);
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const [result, setResult] = useState<SoundMapResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<SoundMapError | null>(null);
  const [retryKey, setRetryKey] = useState(0);
  const [noSeed, setNoSeed] = useState(false);
  const [guideDismissed, setGuideDismissed] = useState(readSoundMapGuideDismissed);
  const [fittedViewport, setFittedViewport] = useState<SoundMapViewport>(DEFAULT_SOUND_MAP_VIEWPORT);
  const [playedIds, setPlayedIds] = useState<Set<number>>(() => new Set());
  const [nearbyExpanded, setNearbyExpanded] = useState(false);
  const requestRevision = useRef(0);
  const loadedKeyRef = useRef<string | null>(null);
  const resultRef = useRef<SoundMapResponse | null>(null);
  const latest = useRef({ searchParams, setSearchParams, state: location.state as unknown });
  useLayoutEffect(() => {
    latest.current = { searchParams, setSearchParams, state: location.state as unknown };
  }, [location.state, searchParams, setSearchParams]);

  const demoMode = import.meta.env.DEV && searchParams.get('demo') === '1';
  const pilotMode = import.meta.env.DEV && searchParams.get('pilot') === '1';
  const localPreviewMode = demoMode || pilotMode;
  const seedId = readId(searchParams.get('seedSongId'));
  const mapVersion = searchParams.get('mapVersion') || undefined;
  const featureMode = !localPreviewMode && (searchParams.get('layout') === 'features' || (!searchParams.has('layout') && !mapVersion));
  const [axisX, axisY] = readSoundMapAxes(searchParams);
  const trail = readSoundMapTrail(location.state);
  const viewport = readViewport(searchParams) ?? fittedViewport;

  /** URL changes that belong to the current history entry (selection, zoom, version) keep its trail. */
  const replaceParams = useCallback((params: URLSearchParams) => {
    latest.current.setSearchParams(params, { replace: true, state: latest.current.state, preventScrollReset: true });
  }, []);

  const applyAxes = useCallback((axes: [number, number] | null) => {
    latest.current.setSearchParams(changeSoundMapAxes(latest.current.searchParams, axes), {
      state: { soundMapTrail: [] },
      preventScrollReset: true,
    });
  }, []);

  const retry = useCallback(() => setRetryKey(key => key + 1), []);

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

  // Starting song: the URL, else the song in the player, else history → ratings → playlists.
  useEffect(() => {
    if (seedId) {
      setNoSeed(false);
      return undefined;
    }
    if (currentSong?.id) {
      const params = new URLSearchParams(latest.current.searchParams);
      params.set('seedSongId', String(currentSong.id));
      replaceParams(params);
      return undefined;
    }
    let active = true;
    void findFallbackSeed().then(id => {
      if (!active) return;
      if (!id) {
        setNoSeed(true);
        return;
      }
      const params = new URLSearchParams(latest.current.searchParams);
      params.set('seedSongId', String(id));
      replaceParams(params);
    });
    return () => {
      active = false;
    };
  }, [currentSong?.id, replaceParams, seedId]);

  useEffect(() => {
    if (!seedId) return undefined;
    const keyParts: RequestKeyParts = { demo: demoMode, pilot: pilotMode, seedId, mapVersion, featureMode, axisX, axisY, retryKey };
    // The map version (and axes) written to the URL after a response describe the map on screen.
    if (requestKey(keyParts) === loadedKeyRef.current) return undefined;
    const revision = ++requestRevision.current;
    const controller = new AbortController();
    setLoading(true);
    const request = demoMode
      ? Promise.resolve(getDemoSoundMap(seedId, mapVersion ?? 'demo-v1'))
      : pilotMode
        ? fetchSoundMapPilot(seedId, controller.signal)
        : fetchSoundMap(seedId, { mapVersion, limit: 120, ...(featureMode ? { axisX, axisY } : {}), signal: controller.signal });
    request
      .then(next => {
        if (revision !== requestRevision.current) return;
        const currentParams = latest.current.searchParams;
        resultRef.current = next;
        setResult(next);
        setError(null);
        if (featureMode && !next.axes) {
          // Older API slots ignore the axis parameters during rollout: this is the automatic layout.
          const params = changeSoundMapAxes(currentParams, null);
          params.set('mapVersion', next.mapVersion);
          params.set('seedSongId', String(seedId));
          loadedKeyRef.current = requestKey({ ...keyParts, mapVersion: next.mapVersion, featureMode: false });
          setFittedViewport(fitSoundMapItems(next.items));
          replaceParams(params);
          return;
        }
        if (!currentParams.has('centerX') && !currentParams.has('centerY')) {
          setFittedViewport(fitSoundMapItems(next.items));
        }
        const writtenSeedId = pilotMode ? next.origin.songId : seedId;
        loadedKeyRef.current = requestKey({ ...keyParts, seedId: writtenSeedId, mapVersion: next.mapVersion });
        if (!mapVersion || mapVersion !== next.mapVersion || writtenSeedId !== seedId) {
          const params = new URLSearchParams(currentParams);
          params.set('mapVersion', next.mapVersion);
          if (featureMode) {
            params.set('layout', 'features');
            params.set('axisX', String(axisX));
            params.set('axisY', String(axisY));
          }
          params.set('seedSongId', String(writtenSeedId));
          replaceParams(params);
        }
      })
      .catch(requestError => {
        if (revision !== requestRevision.current) return;
        if (requestError instanceof Error && requestError.name === 'AbortError') return;
        const failure = classifyError(requestError);
        loadedKeyRef.current = null;
        if (resultRef.current) {
          // The previous map stays on screen. (The wording follows the language at failure time,
          // so a language switch doesn't refetch the map.)
          const currentLanguage = useLanguageStore.getState().language;
          if (failure.kind === 'features_unavailable') {
            showToast(translateSourceText(currentLanguage, 'この曲では特徴軸を使えません'), {
              action: { label: translateSourceText(currentLanguage, 'おまかせに切り替え'), onAction: () => applyAxes(null) },
            });
          } else {
            showToast(translateSourceText(currentLanguage, '更新できませんでした'), {
              action: { label: translateSourceText(currentLanguage, '再試行'), onAction: retry },
            });
          }
          return;
        }
        setError(failure);
      })
      .finally(() => {
        if (revision === requestRevision.current) setLoading(false);
      });
    return () => controller.abort();
  }, [applyAxes, axisX, axisY, demoMode, featureMode, mapVersion, pilotMode, replaceParams, retry, retryKey, seedId]);

  const items = useMemo(() => (result ? visibleSoundMapItems(result.items, hiddenIds) : []), [hiddenIds, result]);
  const selectedId = readId(searchParams.get('selectedSongId')) ?? result?.origin.songId ?? null;
  const selected = items.find(item => item.songId === selectedId) ?? result?.origin ?? null;
  const neighbors = useMemo(
    () => (result ? items.filter(item => item.songId !== result.origin.songId) : []),
    [items, result],
  );
  const songIds = useMemo(() => {
    if (demoMode || !result) return [];
    const visibleNeighbors = nearbyExpanded ? neighbors : neighbors.slice(0, NEARBY_INITIAL_COUNT);
    return [result.origin.songId, ...(selected ? [selected.songId] : []), ...visibleNeighbors.map(point => point.songId)];
  }, [demoMode, nearbyExpanded, neighbors, result, selected]);
  const songsById = useSongsById(songIds);

  const selectPoint = (point: SoundMapPoint) => {
    const params = new URLSearchParams(searchParams);
    params.set('selectedSongId', String(point.songId));
    replaceParams(params);
  };
  const updateViewport = (next: SoundMapViewport) => {
    const params = new URLSearchParams(searchParams);
    params.set('zoom', String(next.zoom));
    params.set('centerX', next.centerX.toFixed(4));
    params.set('centerY', next.centerY.toFixed(4));
    replaceParams(params);
  };
  const setOrigin = (songId: number) => {
    if (!songId || songId === seedId) return;
    const params = new URLSearchParams(searchParams);
    params.set('seedSongId', String(songId));
    params.delete('selectedSongId');
    params.delete('centerX');
    params.delete('centerY');
    // A new history entry: the browser's back button and 「前の起点に戻る」 do the same thing.
    setSearchParams(params, { state: { soundMapTrail: pushSoundMapTrail(trail, seedId) }, preventScrollReset: true });
    const point = items.find(item => item.songId === songId);
    if (point) setFittedViewport(centerSoundMapOnPoint(point, 1));
  };
  const goBackToPreviousOrigin = () => {
    if (trail.length > 0) navigate(-1);
  };
  const focusOrigin = () => {
    if (result) updateViewport(centerSoundMapOnPoint(result.origin, Math.max(1, viewport.zoom)));
  };
  const dismissGuide = () => {
    setGuideDismissed(true);
    try {
      window.localStorage.setItem(SOUND_MAP_GUIDE_STORAGE_KEY, '1');
    } catch {
      // The guide can still be dismissed for this page view when storage is unavailable.
    }
  };

  const withSelectedSong = async (action: (song: Song) => void) => {
    if (!selected) return;
    const song = songsById.get(selected.songId) ?? (await getSongsByIds([selected.songId]))[0];
    if (song) action(song);
  };

  const originSong = result ? songsById.get(result.origin.songId) ?? placeholderSong(result.origin) : null;
  const selectedSong = selected ? songsById.get(selected.songId) ?? placeholderSong(selected) : null;
  const playingSongId = !localPreviewMode && currentSong && result && currentSong.id !== result.origin.songId ? currentSong.id : null;
  const selectionProps = selected && selectedSong && result ? {
    point: selected,
    song: selectedSong,
    isOrigin: selected.songId === result.origin.songId,
    playing: !localPreviewMode && currentSong?.id === selected.songId,
    known: displayKnownIds.has(selected.songId),
    actionsDisabled: localPreviewMode,
    onPlay: () => void withSelectedSong(song => playSong(song, true)),
    onExplore: () => setOrigin(selected.songId),
    onSave: () => void withSelectedSong(song => openSaveToPlaylist(song)),
    onDetails: () => void withSelectedSong(song => openSongDetail(song)),
    onOpenWatch: () => navigate(watchPath(selected.songId)),
    onQueue: () => void withSelectedSong(song => {
      // With nothing playing, an added song would sit in a queue nobody can see: start it instead.
      const player = usePlayerStore.getState();
      if (player.currentSong) player.addToQueue(song);
      else player.setQueue([song], 0);
      showToast(t('キューに追加しました'));
    }),
  } : null;

  const errorView = (failure: SoundMapError) => {
    const title = failure.kind === 'unavailable'
      ? t('曲調マップは準備中です')
      : failure.kind === 'not_mapped'
        ? t('この曲はまだマップにありません')
        : failure.kind === 'features_unavailable'
          ? t('この曲では特徴軸を使えません')
          : failure.kind === 'dependency'
            ? t('接続できませんでした')
            : failure.kind === 'pilot' && failure.message
              ? failure.message
              : t('曲調マップを読み込めませんでした');
    const action: EmptyStateAction = failure.kind === 'features_unavailable'
      ? { label: t('おまかせに切り替え'), onClick: () => applyAxes(null) }
      : failure.kind === 'not_mapped'
        ? { label: t('曲を探す'), to: '/' }
        : { label: t('再試行'), onClick: retry };
    return (
      <div
        role="alert"
        className="flex min-h-[420px] items-center justify-center rounded-card bg-yt-raised max-sm:-mx-3 max-sm:rounded-none"
      >
        <EmptyState icon={<ErrorIcon />} title={title} action={action} />
      </div>
    );
  };

  const uniformAxes = Boolean(result?.axes && (result.axes.minX === result.axes.maxX || result.axes.minY === result.axes.maxY));

  return (
    <PageShell className="pb-8 max-sm:pb-28">
      <div data-testid="sound-map-page">
        <PageHeader
          title={t('曲調マップ')}
          meta={(
            <span className="relative inline-flex h-5 items-center gap-2 align-top sm:-top-0.5">
              <InfoTip label={t('このマップについて')}>
                <p className="m-0">{t('近い点ほど音が似ています。軸はジャンルではありません。')}</p>
                {result && (
                  <p className="m-0 mt-2 text-xs leading-[18px] text-yt-text-secondary tabular-nums">
                    {t('{count}曲 · 更新 {date}', {
                      count: result.coordinateCount.toLocaleString(language === 'ja' ? 'ja-JP' : 'en-US'),
                      date: formatMapDate(result.generatedAt, language),
                    })}
                  </p>
                )}
              </InfoTip>
              {localPreviewMode && (
                <span
                  data-testid="sound-map-preview-chip"
                  className="inline-flex h-6 items-center rounded-chip bg-yt-tonal px-2 text-xs font-medium leading-4 text-yt-text"
                >
                  {demoMode ? t('デモ') : t('パイロット')}
                </span>
              )}
            </span>
          )}
          actions={result && originSong ? (
            <>
              <SoundMapOriginMenu
                song={originSong}
                playing={!localPreviewMode && currentSong?.id === result.origin.songId}
                playingSongId={playingSongId}
                canGoBack={trail.length > 0}
                onUsePlaying={() => {
                  if (playingSongId) setOrigin(playingSongId);
                }}
                onBack={goBackToPreviousOrigin}
              />
              {featureMode && result.axes && (
                <SoundMapSettings
                  axes={result.axes}
                  items={items}
                  selected={selected}
                  disabled={loading}
                  onSelect={selectPoint}
                  renderAxisForm={isMobile ? close => (
                    <SoundMapAxisForm
                      axisX={axisX}
                      axisY={axisY}
                      disabled={loading}
                      onApply={axes => {
                        close();
                        applyAxes(axes);
                      }}
                    />
                  ) : undefined}
                />
              )}
            </>
          ) : undefined}
        />

        {!seedId ? (
          noSeed ? (
            <div className="rounded-card bg-yt-raised">
              <EmptyState icon={<ScatterIcon />} title={t('曲を再生すると、その曲の近くが表示されます')} action={{ label: t('曲を探す'), to: '/' }} />
            </div>
          ) : (
            <SoundMapSkeleton label={t('読み込み中…')} />
          )
        ) : (
          <>
            {!localPreviewMode && (
              <div data-testid="sound-map-axes" className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-3">
                <div role="group" aria-label={t('配置')} data-testid="sound-map-layout" className="flex gap-2 sm:gap-3">
                  <Chip selected={!featureMode} data-layout="pca" onClick={() => { if (featureMode) applyAxes(null); }}>
                    {t('おまかせ')}
                  </Chip>
                  <Chip selected={featureMode} data-layout="features" onClick={() => { if (!featureMode) applyAxes([axisX, axisY]); }}>
                    {t('特徴軸')}
                  </Chip>
                </div>
                {featureMode && !isMobile && (
                  <SoundMapAxisForm axisX={axisX} axisY={axisY} disabled={loading} onApply={applyAxes} />
                )}
              </div>
            )}

            {!result ? (
              error ? errorView(error) : <SoundMapSkeleton label={t('読み込み中…')} />
            ) : (
              <>
                {result.state !== 'ready' && (
                  <InlineNotice className="mb-3">
                    {result.state === 'no_audio' ? t('この曲は音のデータがありません') : t('近い曲がまだありません')}
                  </InlineNotice>
                )}
                {uniformAxes && <InlineNotice tone="warning" className="mb-3">{t('この軸では差が出ません')}</InlineNotice>}
                <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_400px]">
                  <SoundMapCanvas
                    items={items}
                    knownIds={displayKnownIds}
                    originId={result.origin.songId}
                    selectedId={selected?.songId ?? null}
                    viewport={viewport}
                    axes={result.axes}
                    loading={loading}
                    guide={guideDismissed ? null : <SoundMapGuide onDismiss={dismissGuide} />}
                    canGoBack={trail.length > 0}
                    onSelect={selectPoint}
                    onViewportChange={updateViewport}
                    onFocusOrigin={focusOrigin}
                    onBack={goBackToPreviousOrigin}
                  />
                  <div className="flex min-w-0 flex-col gap-6">
                    {!isMobile && selectionProps && <SoundMapSelectionCard {...selectionProps} />}
                    <SoundMapNearby
                      points={neighbors}
                      selectedId={selected?.songId ?? null}
                      songsById={songsById}
                      actionsDisabled={localPreviewMode}
                      initialCount={NEARBY_INITIAL_COUNT}
                      expanded={nearbyExpanded}
                      onExpandedChange={setNearbyExpanded}
                      onSelect={selectPoint}
                    />
                  </div>
                </div>
                {isMobile && selectionProps && <SoundMapSelectionBar {...selectionProps} />}
              </>
            )}
          </>
        )}
      </div>
    </PageShell>
  );
}

function SoundMapSkeleton({ label }: { label: string }) {
  return (
    <div aria-busy="true" className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_400px]">
      <span className="sr-only">{label}</span>
      <SkeletonBlock className="h-[clamp(420px,calc(100vh-240px),640px)] rounded-card max-sm:-mx-3 max-sm:h-[56vh] max-sm:rounded-none" />
      <div className="hidden min-w-0 lg:block">
        <div className="rounded-card bg-yt-raised p-4">
          <SkeletonBlock className="aspect-video w-full rounded-chip" />
          <SkeletonBlock className="mt-3 h-5 w-4/5 rounded-badge" />
          <SkeletonBlock className="mt-2 h-4 w-1/2 rounded-badge" />
          <SkeletonBlock className="mt-4 h-9 w-full rounded-full" />
        </div>
        <div className="mt-6">
          {[0, 1, 2, 3].map(row => <SkeletonListRow key={row} />)}
        </div>
      </div>
    </div>
  );
}
