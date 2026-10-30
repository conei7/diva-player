import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { fetchGroupSoundMap, SoundMapRequestError, type GroupSoundMapResponse, type SoundMapPoint } from '../api/soundMap';
import { getSongsByIds } from '../api/vocadb';
import { searchSongsBackend } from '../search/searchBackendClient';
import { useTranslateSourceText } from '../i18n';
import { usePlayerStore } from '../stores/playerStore';
import { useUiStore } from '../stores/uiStore';
import { useHiddenSongStore } from '../stores/hiddenSongStore';
import { useRatingStore } from '../stores/ratingStore';
import { getPlayedSongIds } from '../services/historyDatabase';
import { MOBILE_MEDIA_QUERY, useMediaQuery } from '../hooks/useMediaQuery';
import { watchPath } from '../utils/routes';
import type { Song } from '../types/vocadb';
import type { SoundMapViewport } from '../utils/soundMap';
import Button from '../components/ui/Button';
import { Chip } from '../components/ui/Chip';
import { PageHeader, PageShell } from '../components/ui/PageHeader';
import InlineNotice from '../components/ui/InlineNotice';
import SoundMapCanvas from '../components/discovery/SoundMapCanvas';
import SoundMapNearby from '../components/discovery/SoundMapNearby';
import SoundMapSelectionCard, { SoundMapSelectionBar } from '../components/discovery/SoundMapSelection';
import { placeholderSong, useSongsById } from '../components/discovery/discoverySongs';

function readGroupSongIds(value: string | null): number[] {
  return [...new Set((value ?? '').split(',').map(Number).filter(id => Number.isSafeInteger(id) && id > 0))].slice(0, 20);
}

function readGroupViewport(params: URLSearchParams): SoundMapViewport | undefined {
  if (!params.has('centerX') || !params.has('centerY')) return undefined;
  const centerX = Number(params.get('centerX')), centerY = Number(params.get('centerY')), zoom = Number(params.get('zoom'));
  return [centerX, centerY, zoom].every(Number.isFinite) && Math.abs(centerX) <= 10 && Math.abs(centerY) <= 10 && zoom >= .75 && zoom <= 256
    ? { centerX, centerY, zoom } : undefined;
}

export default function GroupSoundMapPage() {
  const t = useTranslateSourceText();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const idsKey = params.get('songIds') ?? '';
  const ids = useMemo(() => readGroupSongIds(idsKey), [idsKey]);
  const currentSong = usePlayerStore(state => state.currentSong);
  const hiddenSongs = useHiddenSongStore(state => state.hiddenSongs);
  const ratings = useRatingStore(state => state.ratings);
  const mobile = useMediaQuery(MOBILE_MEDIA_QUERY);
  const [draft, setDraft] = useState(() => ids.length ? ids : readGroupSongIds(params.get('seedSongId') ?? String(currentSong?.id ?? '')));
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState<Song[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState(false);
  const [result, setResult] = useState<GroupSoundMapResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [played, setPlayed] = useState<Set<number>>(new Set());
  const viewport = readGroupViewport(params) ?? result?.initialViewport ?? { centerX: 0, centerY: 0, zoom: 1 };
  const viewportKey = params.has('centerX') ? `${params.get('centerX')},${params.get('centerY')},${params.get('zoom')}` : '';
  const [selectedPoint, setSelectedPoint] = useState<SoundMapPoint | null>(null);
  const groupIds = useMemo(() => new Set(ids), [ids]);
  const known = useMemo(() => new Set([...played, ...Object.keys(ratings).filter(id => ratings[id] > 0).map(Number)]), [played, ratings]);
  const items = useMemo(() => result?.items.filter(p => groupIds.has(p.songId) || !hiddenSongs[p.songId]) ?? [], [result, hiddenSongs, groupIds]);
  const nearby = useMemo(() => items.filter(p => !groupIds.has(p.songId)).slice(0, 20), [items, groupIds]);
  const selected = items.find(p => p.songId === selectedPoint?.songId)
    ?? (selectedPoint && !hiddenSongs[selectedPoint.songId] ? selectedPoint : undefined)
    ?? items.find(p => p.songId === ids[0]);
  const hydrationIds = useMemo(() => [...draft, ...nearby.map(p => p.songId), ...(selected ? [selected.songId] : [])], [draft, nearby, selected]);
  const songs = useSongsById(hydrationIds);

  useEffect(() => { void getPlayedSongIds().then(setPlayed).catch(() => undefined); }, []);

  useEffect(() => {
    let active = true;
    const timer = setTimeout(() => {
      if (!query.trim()) { setSearch([]); setSearching(false); setSearchError(false); return; }
      setSearching(true); setSearchError(false);
      void searchSongsBackend({ query: query.trim(), sort: 'FavoritedTimes', sortOrder: 'desc', start: 0, maxResults: 8, compactCards: true })
        .then(next => { if (active) setSearch(next.items); })
        .catch(() => { if (active) { setSearch([]); setSearchError(true); } })
        .finally(() => { if (active) setSearching(false); });
    }, 300);
    return () => { active = false; clearTimeout(timer); };
  }, [query]);

  useEffect(() => {
    if (ids.length < 3) return;
    const controller = new AbortController();
    const parts = viewportKey.split(',').map(Number);
    const requestedViewport = viewportKey ? { centerX: parts[0], centerY: parts[1], zoom: parts[2] } : undefined;
    const timer = setTimeout(() => {
      setLoading(true); setError(null);
      void fetchGroupSoundMap(ids, { viewport: requestedViewport, signal: controller.signal })
        .then(next => { if (!controller.signal.aborted) setResult(next); })
        .catch((failure: unknown) => {
          if (controller.signal.aborted) return;
          setError(failure instanceof SoundMapRequestError && failure.code === 'group_songs_unavailable'
            ? t('音のデータがないか、マップで使えない曲があります: {ids}', { ids: failure.message })
            : t('マップを読み込めませんでした'));
        }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    }, viewportKey ? 250 : 0);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [ids, viewportKey, retry, t]);

  const add = (id: number) => {
    setDraft(previous => previous.includes(id) || previous.length >= 20 ? previous : [...previous, id]);
    setQuery(''); setSearch([]);
  };
  const updateViewport = (next: SoundMapViewport) => {
    const bounded = { ...next, centerX: Math.max(-10, Math.min(10, next.centerX)), centerY: Math.max(-10, Math.min(10, next.centerY)) };
    const nextParams = new URLSearchParams(params);
    nextParams.set('centerX', bounded.centerX.toFixed(6)); nextParams.set('centerY', bounded.centerY.toFixed(6)); nextParams.set('zoom', String(bounded.zoom));
    setParams(nextParams, { replace: true, preventScrollReset: true });
  };
  const single = (layout: string, id = ids[0] ?? draft[0]) => {
    setParams(new URLSearchParams({ layout, ...(id ? { seedSongId: String(id) } : {}) }), { preventScrollReset: true });
  };
  const act = async (action: (song: Song) => void) => {
    if (!selected) return;
    const song = songs.get(selected.songId) ?? (await getSongsByIds([selected.songId]))[0];
    if (song) action(song);
  };
  const selectionProps = selected ? {
    point: selected, song: songs.get(selected.songId) ?? placeholderSong(selected), isOrigin: false,
    playing: selected.songId === currentSong?.id, known: known.has(selected.songId), actionsDisabled: false,
    onPlay: () => void act(song => usePlayerStore.getState().playSong(song, true)),
    onExplore: () => single('features', selected.songId),
    onSave: () => void act(song => useUiStore.getState().openSaveToPlaylist(song)),
    onDetails: () => void act(song => useUiStore.getState().openSongDetail(song)),
    onOpenWatch: () => navigate(watchPath(selected.songId)),
    onQueue: () => void act(song => usePlayerStore.getState().addToQueue(song)),
  } : null;

  return (
    <PageShell>
      <PageHeader title={t('曲調マップ')} />
      <div className="mb-4 flex flex-wrap gap-2" role="group" aria-label={t('配置')}>
        <Chip selected={false} onClick={() => single('pca')}>{t('おまかせ')}</Chip>
        <Chip selected={false} onClick={() => single('features')}>{t('特徴軸')}</Chip>
        <Chip selected>{t('複数曲')}</Chip>
      </div>
      <div className="mb-4 flex flex-wrap items-center gap-2" data-testid="sound-map-group-songs">
        {draft.map(id => (
          <Chip key={id} aria-label={t('「{song}」を外す', { song: songs.get(id)?.name ?? String(id) })} onClick={() => setDraft(previous => previous.filter(value => value !== id))}>
            <span className="inline-block max-w-48 truncate align-middle">{songs.get(id)?.name ?? `#${id}`}</span> ×
          </Chip>
        ))}
        {currentSong && !draft.includes(currentSong.id) && <Button size="sm" disabled={draft.length >= 20} onClick={() => add(currentSong.id)}>{t('再生中の曲を追加')}</Button>}
        <Button variant="primary" disabled={draft.length < 3 || draft.length > 20} onClick={() => setParams(new URLSearchParams({ layout: 'group', songIds: draft.join(',') }), { preventScrollReset: true })}>{t('マップを作る')}</Button>
      </div>
      <div className="relative mb-4 max-w-lg">
        <input className="h-10 w-full rounded-chip border border-yt-field-border bg-yt-field px-3 text-sm text-yt-text outline-none focus:border-yt-focus" aria-label={t('マップに追加する曲を検索')} placeholder={t('曲を追加（3〜20曲）')} value={query} maxLength={200} onChange={e => { setQuery(e.target.value); setSearch([]); setSearching(Boolean(e.target.value.trim())); setSearchError(false); }} />
        {query.trim() && (
          <div className="absolute inset-x-0 top-full z-10 mt-1 rounded-card bg-yt-menu p-1 shadow-lg" aria-live="polite">
            {searching ? <p className="px-3 text-sm">{t('検索中…')}</p> : searchError ? <p className="px-3 text-sm">{t('検索できませんでした')}</p> : search.length === 0 ? <p className="px-3 text-sm">{t('曲が見つかりませんでした')}</p> : search.map(song => (
              <button key={song.id} type="button" className="block w-full rounded-chip px-3 py-2 text-left text-sm hover:bg-yt-tonal disabled:opacity-50" disabled={draft.includes(song.id) || draft.length >= 20} onClick={() => add(song.id)}>
                <span className="block truncate font-medium">{song.name}</span><span className="block truncate text-xs text-yt-text-secondary">{song.artistString}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      {error && <InlineNotice className="mb-3">{error} <Button size="sm" onClick={() => setRetry(n => n + 1)}>{t('再試行')}</Button></InlineNotice>}
      {!result && !loading && ids.length < 3 && <p className="text-sm text-yt-text-secondary">{t('3曲以上追加して、マップを作成してください')}</p>}
      {loading && !result && <p role="status" className="text-sm text-yt-text-secondary">{t('マップを準備中…初回は少し時間がかかります')}</p>}
      {result && (
        <>
          <div className="mb-2 flex flex-wrap items-center gap-3 text-xs text-yt-text-secondary">
            <span>{t('表示 {shown}曲 · 音源データ {total}曲', { shown: items.length, total: result.coordinateCount.toLocaleString() })}</span>
            {result.matchingCount > 876 && viewport.zoom < 256 && <span>{t('拡大すると、さらに曲が表示されます')}</span>}
            {selected && !draft.includes(selected.songId) && <Button size="sm" disabled={draft.length >= 20} onClick={() => add(selected.songId)}>{t('選択した曲を追加')}</Button>}
          </div>
          <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_400px]">
            <SoundMapCanvas items={items} knownIds={known} originId={ids[0]} originIds={groupIds} maxZoom={256} allowTouchPan selectedId={selected?.songId ?? null} viewport={viewport} axes={result.axes} loading={loading} canGoBack={false}
              onSelect={setSelectedPoint} onViewportChange={updateViewport} onFocusOrigin={() => updateViewport(result.initialViewport)} onBack={() => undefined} />
            <div className="flex min-w-0 flex-col gap-6">
              {!mobile && selectionProps && <SoundMapSelectionCard {...selectionProps} />}
              <SoundMapNearby points={nearby} selectedId={selected?.songId ?? null} songsById={songs} actionsDisabled={false} initialCount={20} expanded={false} onExpandedChange={() => undefined} onSelect={setSelectedPoint} />
            </div>
          </div>
          {mobile && selectionProps && <SoundMapSelectionBar {...selectionProps} />}
        </>
      )}
    </PageShell>
  );
}
