import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { searchSongsBackend, refreshSearchRandomSeed } from '../search/searchBackendClient';
import type { Song } from '../types/vocadb';
import { usePlayerStore } from '../stores/playerStore';
import { useProgressStore } from '../stores/progressStore';
import { useRatingStore } from '../stores/ratingStore';
import { useUiStore } from '../stores/uiStore';
import { useLanguageStore } from '../stores/languageStore';
import { useTranslateSourceText } from '../i18n';
import { MOBILE_MEDIA_QUERY, useMediaQuery } from '../hooks/useMediaQuery';
import { formatClockDuration, formatCount } from '../utils/songMeta';
import { getWideSongThumbnailCandidates } from '../utils/songThumbnail';
import Button from '../components/ui/Button';
import EmptyState from '../components/ui/EmptyState';
import IconButton from '../components/ui/IconButton';
import { PageHeader, PageShell } from '../components/ui/PageHeader';
import { SkeletonBlock, SkeletonListRow } from '../components/ui/Skeleton';
import SongActionsMenu from '../components/ui/SongActionsMenu';
import SongListRow from '../components/ui/SongListRow';
import SongThumbnail from '../components/ui/SongThumbnail';
import { ChorusIcon, ErrorIcon, PlayIcon, RefreshIcon } from '../components/ui/icons';
import ChorusNowPlaying from '../components/library/ChorusNowPlaying';
import LibraryHero from '../components/library/LibraryHero';
import RowBadge from '../components/library/RowBadge';
import { useIsMusicLayout } from '../hooks/useMusicLayout';

/** Stored as the queue name; displayQueueTitle() translates it where it is shown. */
const QUEUE_TITLE = 'サビ発掘';
const CANDIDATE_COUNT = 60;
const DEFAULT_WINDOW_SECONDS = 15;

export default function ChorusHighlightsPage() {
  const t = useTranslateSourceText();
  const language = useLanguageStore(state => state.language);
  const isMobile = useMediaQuery(MOBILE_MEDIA_QUERY);
  const musicLayout = useIsMusicLayout();
  const [candidates, setCandidates] = useState<Song[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [active, setActive] = useState(false);
  const [fullSongId, setFullSongId] = useState<number | null>(null);
  const soughtSongId = useRef<number | null>(null);
  const advancedSongId = useRef<number | null>(null);
  const actionsRef = useRef<HTMLDivElement>(null);

  const currentSong = usePlayerStore(state => state.currentSong);
  const queue = usePlayerStore(state => state.queue);
  const next = usePlayerStore(state => state.next);
  const seekTo = usePlayerStore(state => state.seekTo);
  const progress = useProgressStore(state => state.progress);
  const duration = useProgressStore(state => state.duration);
  const ratings = useRatingStore(state => state.ratings);
  const setRating = useRatingStore(state => state.setRating);

  const loadCandidates = useCallback(async () => {
    setLoading(true);
    setFailed(false);
    setActive(false);
    refreshSearchRandomSeed();
    try {
      const result = await searchSongsBackend({
        sort: 'Random',
        sortOrder: 'desc',
        start: 0,
        maxResults: CANDIDATE_COUNT,
        discoveryOnly: true,
        chorusOnly: true,
      });
      setCandidates(result.items.filter(song =>
        song.chorusStartSeconds != null
        && song.pvs?.some(pv => !pv.disabled && ['Youtube', 'NicoNicoDouga', 'SoundCloud'].includes(pv.service)),
      ));
    } catch {
      setFailed(true);
      setCandidates([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadCandidates(); }, [loadCandidates]);

  const candidateIds = useMemo(() => new Set(candidates.map(song => song.id)), [candidates]);
  const isHighlightSong = active && !!currentSong && candidateIds.has(currentSong.id);
  const startSeconds = isHighlightSong ? currentSong?.chorusStartSeconds ?? 0 : 0;
  // Keep the active actions above the fixed player when playback starts or its size changes.
  // Listening for the shared clearance also covers the player controls finishing their lazy load.
  useEffect(() => {
    if (!isMobile || !isHighlightSong) return;
    let frame = 0;
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => actionsRef.current?.scrollIntoView({ block: 'nearest' }));
    };
    const layout = new MutationObserver(schedule);
    layout.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });
    const actions = new ResizeObserver(schedule);
    if (actionsRef.current) actions.observe(actionsRef.current);
    schedule();
    return () => {
      cancelAnimationFrame(frame);
      layout.disconnect();
      actions.disconnect();
    };
  }, [isMobile, isHighlightSong]);
  const endSeconds = isHighlightSong
    ? Math.min(
      duration || currentSong?.lengthSeconds || startSeconds + DEFAULT_WINDOW_SECONDS,
      currentSong?.chorusEndSeconds ?? startSeconds + DEFAULT_WINDOW_SECONDS,
    )
    : 0;

  // Jump to the chorus once per song.
  useEffect(() => {
    if (!isHighlightSong || !currentSong || duration <= 0) return;
    if (soughtSongId.current === currentSong.id) return;
    soughtSongId.current = currentSong.id;
    advancedSongId.current = null;
    seekTo(currentSong.chorusStartSeconds ?? 0);
  }, [currentSong, duration, isHighlightSong, seekTo]);

  // Move on when the chorus ends, unless the song is being heard in full.
  useEffect(() => {
    if (!isHighlightSong || !currentSong || endSeconds <= 0) return;
    if (fullSongId === currentSong.id) return;
    if (progress < endSeconds - 0.2 || advancedSongId.current === currentSong.id) return;
    advancedSongId.current = currentSong.id;
    next();
  }, [currentSong, endSeconds, fullSongId, isHighlightSong, next, progress]);

  // The highlight songs in the order the player plays them (it may be shuffled).
  const highlightQueue = useMemo(() => queue.filter(song => candidateIds.has(song.id)), [candidateIds, queue]);
  const position = isHighlightSong && currentSong ? highlightQueue.findIndex(song => song.id === currentSong.id) : -1;
  const upNext = isHighlightSong && position >= 0 ? highlightQueue.slice(position + 1) : candidates;

  const startHighlights = (index = 0) => {
    if (candidates.length === 0) return;
    soughtSongId.current = null;
    advancedSongId.current = null;
    setFullSongId(null);
    setActive(true);
    usePlayerStore.getState().setQueue(candidates, Math.max(0, Math.min(index, candidates.length - 1)), true, 'discovery', QUEUE_TITLE);
  };

  const playSong = (song: Song) => {
    if (isHighlightSong) {
      const queueIndex = usePlayerStore.getState().queue.findIndex(item => item.id === song.id);
      if (queueIndex >= 0) {
        usePlayerStore.getState().jumpToIndex(queueIndex);
        return;
      }
    }
    startHighlights(candidates.findIndex(item => item.id === song.id));
  };

  const skip = () => {
    if (currentSong) advancedSongId.current = currentSong.id;
    next();
  };

  const elapsed = isHighlightSong ? Math.max(0, progress - startSeconds) : 0;
  const windowLength = Math.max(1, endSeconds - startSeconds || DEFAULT_WINDOW_SECONDS);

  if (failed || (!loading && candidates.length === 0)) {
    return (
      <div data-testid="chorus-highlights-page">
        <PageShell>
          <PageHeader title={t('サビ発掘')} />
          {failed ? (
            <EmptyState
              icon={<ErrorIcon />}
              title={t('読み込めませんでした')}
              action={{ label: t('再試行'), onClick: () => void loadCandidates() }}
            />
          ) : (
            <EmptyState
              icon={<ChorusIcon />}
              title={t('サビ候補はまだありません')}
              action={{ label: t('再読み込み'), onClick: () => void loadCandidates() }}
            />
          )}
        </PageShell>
      </div>
    );
  }

  const collage = candidates.slice(0, 4);
  const refreshButton = isMobile ? (
    <IconButton
      label={t('入れ替え')}
      icon={<RefreshIcon />}
      variant="tonal"
      className="size-11!"
      disabled={loading}
      onClick={() => void loadCandidates()}
    />
  ) : (
    <Button size="lg" icon={<RefreshIcon />} disabled={loading} onClick={() => void loadCandidates()}>
      {t('入れ替え')}
    </Button>
  );

  return (
    <div data-testid="chorus-highlights-page">
      <PageShell>
        <div className={musicLayout ? 'flex flex-col gap-6' : 'flex flex-col gap-6 xl:flex-row xl:items-start'}>
          <LibraryHero
            titleId="chorus-highlights-title"
            title={t('サビ発掘')}
            meta={loading
              ? <SkeletonBlock className="h-4 w-32 rounded-badge" />
              : `${formatCount(candidates.length, 'song', language)} · ${t('1曲15秒')}`}
            backdropUrl={collage[0] ? getWideSongThumbnailCandidates(collage[0])[0] : undefined}
            cover={loading ? <SkeletonBlock className="aspect-video w-full rounded-card" /> : (
              <div className="group/collage relative grid aspect-video grid-cols-2 grid-rows-2 overflow-hidden rounded-card bg-yt-tonal-solid">
                {collage.map(song => (
                  <SongThumbnail key={song.id} song={song} className="h-full w-full" radius="none" showDuration={false} loading="eager" />
                ))}
                <button
                  type="button"
                  onClick={() => startHighlights(0)}
                  className="absolute inset-0 flex cursor-pointer items-center justify-center gap-2 bg-black/60 text-sm leading-5 font-medium text-white opacity-0 transition-opacity duration-150 group-hover/collage:opacity-100 focus-visible:opacity-100"
                >
                  <PlayIcon />
                  {t('再生')}
                </button>
              </div>
            )}
            actionsLayout={isMobile ? 'fill-first' : 'equal'}
            actions={(
              <>
                <Button
                  variant="primary"
                  size="lg"
                  icon={<PlayIcon />}
                  disabled={loading || candidates.length === 0}
                  onClick={() => startHighlights(0)}
                >
                  {t('再生')}
                </Button>
                {refreshButton}
              </>
            )}
          />

          <div className="min-w-0 flex-1">
            {loading ? (
              <div aria-busy="true" className="-mx-2">
                {Array.from({ length: 6 }, (_, index) => <SkeletonListRow key={index} size="sm" />)}
              </div>
            ) : (
              <>
                {isHighlightSong && currentSong && (
                  <div className="mb-6">
                    <ChorusNowPlaying
                      song={currentSong}
                      position={position + 1}
                      total={highlightQueue.length}
                      startSeconds={startSeconds}
                      elapsed={elapsed}
                      windowLength={windowLength}
                      fullSong={fullSongId === currentSong.id}
                      progress={progress}
                      duration={duration}
                      rating={ratings[String(currentSong.id)] ?? 0}
                      onRate={rating => setRating(currentSong.id, rating)}
                      onSave={() => useUiStore.getState().openSaveToPlaylist(currentSong)}
                      onToggleFullSong={() => setFullSongId(previous => (previous === currentSong.id ? null : currentSong.id))}
                      onSkip={skip}
                      actionsRef={actionsRef}
                    />
                  </div>
                )}
                {upNext.length > 0 && (
                  <section aria-labelledby="chorus-up-next">
                    <h2 id="chorus-up-next" className="m-0 mb-2 text-base leading-[22px] font-bold text-yt-text">{t('次のサビ')}</h2>
                    <div className="-mx-2">
                      {upNext.map(song => (
                        <SongListRow
                          key={song.id}
                          song={song}
                          size="sm"
                          onActivate={() => playSong(song)}
                          badges={song.chorusStartSeconds != null ? (
                            <RowBadge>{t('サビ {time}〜', { time: formatClockDuration(song.chorusStartSeconds) })}</RowBadge>
                          ) : undefined}
                          trailing={<SongActionsMenu song={song} />}
                        />
                      ))}
                    </div>
                  </section>
                )}
              </>
            )}
          </div>
        </div>
      </PageShell>
    </div>
  );
}
