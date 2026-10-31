import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import { useHistoryStore } from '../stores/historyStore';
import { useRatingStore } from '../stores/ratingStore';
import { useHiddenSongStore } from '../stores/hiddenSongStore';
import { useLanguageStore } from '../stores/languageStore';
import { usePlayerStore } from '../stores/playerStore';
import { useSelectionStore } from '../stores/selectionStore';
import { useUiStore } from '../stores/uiStore';
import { showToast } from '../stores/toastStore';
import { useTranslateSourceText } from '../i18n';
import { getSongsByIds } from '../api/vocadb';
import type { Song } from '../types/vocadb';
import { MOBILE_MEDIA_QUERY, useMediaQuery } from '../hooks/useMediaQuery';
import { formatCount, formatTotalDuration } from '../utils/songMeta';
import { getWideSongThumbnailCandidates } from '../utils/songThumbnail';
import {
  filterSongsByText,
  getDefaultRating,
  getRatingCounts,
  getSongIdsForRating,
  isRatingValue,
  RATING_VALUES,
  sortRatedSongs,
  type RatedSongSortMode,
  type RatingValue,
} from '../utils/ratedSongs';
import StarRating from '../components/player/StarRating';
import { addSongsToQueue } from '../components/playlist/playlistQueue';
import Button from '../components/ui/Button';
import { Chip, ChipBar } from '../components/ui/Chip';
import EmptyState from '../components/ui/EmptyState';
import IconButton from '../components/ui/IconButton';
import InlineNotice from '../components/ui/InlineNotice';
import Menu, { MenuItem } from '../components/ui/Menu';
import { PageHeader, PageShell } from '../components/ui/PageHeader';
import SearchField from '../components/ui/SearchField';
import { SkeletonListRow } from '../components/ui/Skeleton';
import SongActionsMenu from '../components/ui/SongActionsMenu';
import SongListRow from '../components/ui/SongListRow';
import SongThumbnail from '../components/ui/SongThumbnail';
import SortMenu from '../components/ui/SortMenu';
import {
  MoreVertIcon,
  PlayIcon,
  PlaylistAddIcon,
  QueueMusicIcon,
  ShuffleIcon,
  StarIcon,
} from '../components/ui/icons';
import LibraryHero from '../components/library/LibraryHero';
import RowBadge from '../components/library/RowBadge';
import { useIsMusicLayout } from '../hooks/useMusicLayout';

const MAX_SKELETON_ROWS = 12;

/**
 * FavoritesPage - 評価した曲（★ごと。プレイリストの詳細と同じ「ヒーロー＋一覧」の型）
 */
export default function FavoritesPage() {
  const t = useTranslateSourceText();
  const language = useLanguageStore(state => state.language);
  const isMobile = useMediaQuery(MOBILE_MEDIA_QUERY);
  const musicLayout = useIsMusicLayout();
  const ratings = useRatingStore(state => state.ratings);
  const setRating = useRatingStore(state => state.setRating);
  const entries = useHistoryStore(state => state.entries);
  const lastPlayedAtBySongId = useHistoryStore(state => state.lastPlayedAtBySongId);
  const hiddenSongs = useHiddenSongStore(state => state.hiddenSongs);
  const currentSongId = usePlayerStore(state => state.currentSong?.id);
  const isSelectionMode = useSelectionStore(state => state.isSelectionMode);
  const selectedSongIds = useSelectionStore(state => state.selectedSongIds);
  const toggleSong = useSelectionStore(state => state.toggleSong);
  const setVisibleSongs = useSelectionStore(state => state.setVisibleSongs);
  const [searchParams, setSearchParams] = useSearchParams();
  const [filterText, setFilterText] = useState('');
  const [sortMode, setSortMode] = useState<RatedSongSortMode>('recent');
  const [loadedSongs, setLoadedSongs] = useState<ReadonlyMap<number, Song>>(() => new Map());
  const [failedIds, setFailedIds] = useState<ReadonlySet<number>>(() => new Set());

  const ratingCounts = useMemo(() => getRatingCounts(ratings), [ratings]);
  const totalRated = RATING_VALUES.reduce((sum, rating) => sum + ratingCounts[rating], 0);
  const ratingParam = Number(searchParams.get('rating'));
  const selectedRating: RatingValue = isRatingValue(ratingParam) ? ratingParam : getDefaultRating(ratingCounts);
  const selectedRatedIds = useMemo(
    () => getSongIdsForRating(ratings, selectedRating),
    [ratings, selectedRating],
  );

  const songsById = useMemo(() => {
    const map = new Map(loadedSongs);
    for (const entry of entries) map.set(entry.song.id, entry.song);
    return map;
  }, [entries, loadedSongs]);

  // Songs that are neither in the loaded history nor fetched yet: fetched in one compact batch.
  const missingIds = useMemo(
    () => selectedRatedIds.filter(id => !songsById.has(id) && !failedIds.has(id)),
    [failedIds, selectedRatedIds, songsById],
  );
  const missingKey = missingIds.join(',');

  useEffect(() => {
    if (!missingKey) return;
    const ids = missingKey.split(',').map(Number);
    let cancelled = false;
    void getSongsByIds(ids)
      .catch(() => [] as Song[])
      .then(songs => {
        if (cancelled) return;
        const found = new Set(songs.map(song => song.id));
        setLoadedSongs(previous => {
          const next = new Map(previous);
          for (const song of songs) next.set(song.id, song);
          return next;
        });
        setFailedIds(previous => {
          const next = new Set(previous);
          for (const id of ids) if (!found.has(id)) next.add(id);
          return next;
        });
      });
    return () => { cancelled = true; };
  }, [missingKey]);

  const failedCount = useMemo(
    () => selectedRatedIds.filter(id => failedIds.has(id)).length,
    [failedIds, selectedRatedIds],
  );

  const favoriteSongs = useMemo(() => {
    const seen = new Set<number>();
    const result: Song[] = [];
    for (const id of selectedRatedIds) {
      const song = songsById.get(id);
      if (song && !seen.has(song.id)) {
        seen.add(song.id);
        result.push(song);
      }
    }
    return result;
  }, [selectedRatedIds, songsById]);

  const visibleSongs = useMemo(
    () => sortRatedSongs(filterSongsByText(favoriteSongs, filterText), sortMode, lastPlayedAtBySongId),
    [favoriteSongs, filterText, lastPlayedAtBySongId, sortMode],
  );

  useEffect(() => {
    setVisibleSongs(visibleSongs);
  }, [setVisibleSongs, visibleSongs]);

  const queueTitle = t('評価した曲 ★{rating}', { rating: selectedRating });
  const totalSeconds = favoriteSongs.reduce((sum, song) => sum + (song.lengthSeconds > 0 ? song.lengthSeconds : 0), 0);
  const coverSong = visibleSongs[0] ?? favoriteSongs[0];

  const selectRating = (rating: RatingValue) => {
    setFilterText('');
    setSearchParams({ rating: String(rating) }, { replace: true });
  };

  const playFrom = (index: number) => {
    if (visibleSongs.length === 0) return;
    usePlayerStore.getState().setQueue(visibleSongs, index, true, 'manual', queueTitle);
  };

  const shuffle = () => {
    if (visibleSongs.length === 0) return;
    usePlayerStore.getState().setQueueShuffled(visibleSongs, queueTitle);
  };

  const addAllToQueue = () => {
    if (visibleSongs.length === 0) return;
    // With nothing playing the songs start in the mini player instead of an invisible queue.
    addSongsToQueue(visibleSongs, queueTitle);
    showToast(t('キューに追加しました'));
  };

  const removeRating = (song: Song) => {
    const previous = useRatingStore.getState().getRating(song.id);
    if (!previous) return;
    // setRating with the current value clears it (the store's toggle).
    setRating(song.id, previous);
    showToast(t('評価を外しました'), {
      action: { label: t('元に戻す'), onAction: () => useRatingStore.getState().setRating(song.id, previous) },
    });
  };

  const changeRating = (song: Song, rating: number) => {
    if (rating === useRatingStore.getState().getRating(song.id)) removeRating(song);
    else setRating(song.id, rating);
  };

  const retryFailed = () => {
    setFailedIds(previous => {
      const next = new Set(previous);
      for (const id of selectedRatedIds) next.delete(id);
      return next;
    });
  };

  if (totalRated === 0) {
    return (
      <PageShell>
        <PageHeader title={t('評価した曲')} />
        <EmptyState icon={<StarIcon />} title={t('評価した曲はありません')} action={{ label: t('曲を探す'), to: '/' }} />
      </PageShell>
    );
  }

  const hasSongs = favoriteSongs.length > 0;
  const sortOptions: Array<{ value: RatedSongSortMode; label: string }> = [
    { value: 'recent', label: t('最近聴いた順') },
    { value: 'name', label: t('曲名順') },
    { value: 'artist', label: t('アーティスト順') },
  ];

  let list: ReactNode;
  if (visibleSongs.length > 0) {
    list = visibleSongs.map((song, index) => {
      const hidden = Boolean(hiddenSongs[String(song.id)]);
      const badges: ReactNode[] = [];
      if (!isMobile) {
        badges.push(
          <span key="rating" className="flex items-center">
            <StarRating size="sm" rating={selectedRating} onRate={rating => changeRating(song, rating)} />
          </span>,
        );
      }
      if (hidden) badges.push(<RowBadge key="hidden">{t('非表示中')}</RowBadge>);
      return (
        <SongListRow
          key={song.id}
          song={song}
          size={isMobile ? 'sm' : 'md'}
          active={song.id === currentSongId}
          onActivate={() => playFrom(index)}
          leading={isMobile ? undefined : (
            <span className="w-6 text-center text-sm leading-5 text-yt-text-secondary tabular-nums">{index + 1}</span>
          )}
          badges={badges.length > 0 ? badges : undefined}
          trailing={isSelectionMode ? undefined : (
            <SongActionsMenu
              song={song}
              extraItems={isMobile ? (
                <MenuItem keepOpen icon={<StarIcon />}>
                  <span className="flex items-center">
                    <StarRating rating={selectedRating} onRate={rating => changeRating(song, rating)} />
                  </span>
                </MenuItem>
              ) : undefined}
              footerItems={(
                <MenuItem icon={<StarIcon />} onSelect={() => removeRating(song)}>{t('評価を外す')}</MenuItem>
              )}
            />
          )}
          selectionMode={isSelectionMode}
          selected={selectedSongIds.has(song.id)}
          onToggleSelect={() => toggleSong(song)}
          className="-mx-2"
        />
      );
    });
  } else if (hasSongs) {
    list = <EmptyState compact title={t('一致する曲はありません')} />;
  } else if (missingIds.length === 0 && failedCount === 0) {
    list = <EmptyState compact icon={<StarIcon />} title={t('★{rating}の曲はありません', { rating: selectedRating })} />;
  }

  const skeletonCount = filterText.trim() ? 0 : Math.min(missingIds.length, MAX_SKELETON_ROWS);

  return (
    <PageShell>
      <div className={musicLayout ? 'flex flex-col gap-6' : 'flex flex-col gap-6 xl:flex-row xl:items-start'}>
        <LibraryHero
          titleId="favorites-title"
          title={t('評価した曲')}
          meta={[
            `★${selectedRating}`,
            formatCount(ratingCounts[selectedRating], 'song', language),
            totalSeconds > 0 ? formatTotalDuration(totalSeconds, language) : null,
          ].filter(Boolean).join(' · ')}
          backdropUrl={coverSong ? getWideSongThumbnailCandidates(coverSong)[0] : undefined}
          cover={coverSong ? (
            <SongThumbnail
              song={coverSong}
              className="w-full"
              showDuration={false}
              loading="eager"
              overlay={(
                <button
                  type="button"
                  onClick={() => playFrom(0)}
                  className="flex h-full w-full cursor-pointer items-center justify-center gap-2 bg-black/60 text-sm leading-5 font-medium text-white"
                >
                  <PlayIcon />
                  {t('すべて再生')}
                </button>
              )}
            />
          ) : undefined}
          iconActions={hasSongs ? (
            <>
              <IconButton
                label={t('プレイリストに保存')}
                icon={<PlaylistAddIcon />}
                variant="tonal"
                disabled={visibleSongs.length === 0}
                onClick={() => useUiStore.getState().openSaveToPlaylist(visibleSongs)}
              />
              <Menu trigger={<IconButton label={t('その他の操作')} icon={<MoreVertIcon />} variant="tonal" />}>
                <MenuItem icon={<QueueMusicIcon />} disabled={visibleSongs.length === 0} onSelect={addAllToQueue}>
                  {t('キューに追加')}
                </MenuItem>
              </Menu>
            </>
          ) : undefined}
          actions={hasSongs ? (
            <>
              <Button variant="primary" size="lg" icon={<PlayIcon />} disabled={visibleSongs.length === 0} onClick={() => playFrom(0)}>
                {t('すべて再生')}
              </Button>
              <Button size="lg" icon={<ShuffleIcon />} disabled={visibleSongs.length === 0} onClick={shuffle}>
                {t('シャッフル')}
              </Button>
            </>
          ) : undefined}
        />

        <div className="min-w-0 flex-1">
          {/* Like the playlist's list header: sticky from 640px, 選択 at the right end. */}
          <ChipBar
            label={t('評価で絞り込む')}
            sticky={!isMobile}
            className="min-h-12"
            trailing={hasSongs ? (
              <>
                <SearchField
                  expandable
                  value={filterText}
                  onChange={setFilterText}
                  label={t('評価した曲を検索')}
                  width={isMobile ? 180 : 240}
                />
                <SortMenu value={sortMode} options={sortOptions} onChange={setSortMode} compact={isMobile} />
              </>
            ) : undefined}
          >
            {RATING_VALUES.map(rating => (
              <Chip
                key={rating}
                selected={rating === selectedRating}
                count={ratingCounts[rating]}
                onClick={() => selectRating(rating)}
              >
                {`★${rating}`}
              </Chip>
            ))}
          </ChipBar>

          {failedCount > 0 && (
            <InlineNotice
              tone="warning"
              className="mt-4"
              action={{ label: t('再試行'), onClick: retryFailed }}
            >
              {t('読み込めない曲 {count}', { count: formatCount(failedCount, language === 'ja' ? 'item' : 'song', language) })}
            </InlineNotice>
          )}

          <div className="mt-3">
            {list}
            {skeletonCount > 0 && (
              <div aria-busy="true" className="-mx-2">
                {Array.from({ length: skeletonCount }, (_, index) => (
                  <SkeletonListRow key={index} size={isMobile ? 'sm' : 'md'} />
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </PageShell>
  );
}
