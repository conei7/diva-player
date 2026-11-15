import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { searchSongsBackend } from '../../search/searchBackendClient';
import { useFavoriteProducerStore, type FavoriteProducer } from '../../stores/favoriteProducerStore';
import { useGlobalFilterStore, type GlobalFilterSettings } from '../../stores/globalFilterStore';
import { excludeHiddenSongs, useHiddenSongStore } from '../../stores/hiddenSongStore';
import { usePlayerStore } from '../../stores/playerStore';
import { useLanguageStore } from '../../stores/languageStore';
import { MOBILE_MEDIA_QUERY, useMediaQuery } from '../../hooks/useMediaQuery';
import { formatArtistLine } from '../../utils/songMeta';
import { formatSongRelativeDate } from '../../utils/relativeDate';
import { matchesGlobalSongFilter } from '../../utils/globalFilters';
import { isPublishedFollowedRelease, isUncheckedRelease, releaseCheckDay } from '../../utils/followedReleases';
import { watchPath } from '../../utils/routes';
import { useTranslateSourceText } from '../../i18n';
import type { Song } from '../../types/vocadb';
import Button from '../ui/Button';
import EmptyState from '../ui/EmptyState';
import { SkeletonListRow } from '../ui/Skeleton';
import SongListRow from '../ui/SongListRow';
import SongActionsMenu from '../ui/SongActionsMenu';
import RowBadge from './RowBadge';

const PAGE_SIZE = 40;

export default function FollowedReleases({ producers }: { producers: FavoriteProducer[] }) {
  const settings = useGlobalFilterStore();
  // Read acknowledgements without throwing away the open feed. A changed follow
  // list or filter starts a fresh generation, so stale responses cannot leak in.
  const identity = producers.map(producer => `${producer.id}:${producer.createdAt}`).sort().join(',');
  return <ReleaseFeed key={`${identity}:${JSON.stringify(settings)}`} producers={producers} settings={settings} />;
}

function ReleaseFeed({ producers, settings }: { producers: FavoriteProducer[]; settings: GlobalFilterSettings }) {
  const t = useTranslateSourceText();
  const navigate = useNavigate();
  const mobile = useMediaQuery(MOBILE_MEDIA_QUERY);
  const language = useLanguageStore(state => state.language);
  const rowSize = mobile ? 'sm' : 'md';
  const hiddenSongs = useHiddenSongStore(state => state.hiddenSongs);
  const playingId = usePlayerStore(state => state.currentSong?.id);
  const markChecked = useFavoriteProducerStore(state => state.markReleasesChecked);
  const [songs, setSongs] = useState<Song[]>([]);
  const [start, setStart] = useState(0);
  const [nextStart, setNextStart] = useState(0);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [retry, setRetry] = useState(0);
  const [checkedThrough, setCheckedThrough] = useState(0);
  const producerIds = producers.map(producer => producer.id).sort((a, b) => a - b).join(',');

  useEffect(() => {
    let active = true;
    const requestedAt = Date.now();
    searchSongsBackend({
      anyArtistIds: producerIds.split(',').map(Number),
      sort: 'PublishDate', sortOrder: 'desc', start, maxResults: PAGE_SIZE,
      globalFilters: settings, discoveryOnly: true, compactCards: true,
    }).then(result => {
      if (!active) return;
      setSongs(previous => [...new Map([...previous, ...result.items].map(song => [song.id, song])).values()]);
      setNextStart(start + result.items.length);
      const more = result.items.length === PAGE_SIZE && start + result.items.length < result.totalCount;
      setHasMore(more);
      setCheckedThrough(requestedAt);
      setFailed(false);
      const eligible = excludeHiddenSongs(result.items, useHiddenSongStore.getState().hiddenSongs)
        .some(song => matchesGlobalSongFilter(song, settings)
          && isPublishedFollowedRelease(song, useFavoriteProducerStore.getState().producers, requestedAt));
      if (more && !eligible) {
        setStart(start + result.items.length);
        return;
      }
      setLoading(false);
    }).catch(() => {
      if (!active) return;
      setFailed(true);
      setLoading(false);
    });
    return () => { active = false; };
  }, [producerIds, settings, start, retry]);

  const visible = useMemo(() => excludeHiddenSongs(songs, hiddenSongs)
    .filter(song => matchesGlobalSongFilter(song, settings)
      && isPublishedFollowedRelease(song, producers, Date.now())), [songs, hiddenSongs, settings, producers]);
  const unchecked = visible.filter(song => isUncheckedRelease(song, producers, Date.now()));
  const loadMore = () => { setLoading(true); setFailed(false); setStart(nextStart); };

  return (
    <section aria-label={t('フォロー中の新曲')}>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <p className="m-0 flex-1 text-sm text-yt-text-secondary">{t('公開日が新しい順')}</p>
        <Button variant="text" disabled={loading || failed || unchecked.length === 0}
          onClick={() => markChecked(producers.map(producer => producer.id), checkedThrough,
            visible.filter(song => (song.publishDate?.slice(0, 10) ?? '') >= releaseCheckDay(checkedThrough)).map(song => song.id))}>
          {t('すべて確認済みにする')}
        </Button>
      </div>
      {visible.map(song => (
        <SongListRow key={song.id} song={song} size={rowSize} data-testid="followed-release-row"
          meta={mobile ? [formatArtistLine(song), formatSongRelativeDate(song, Date.now(), language)] : undefined}
          active={song.id === playingId} onActivate={() => navigate(watchPath(song.id))}
          badges={isUncheckedRelease(song, producers, Date.now()) ? <RowBadge>{t('未確認')}</RowBadge> : undefined}
          trailing={<SongActionsMenu song={song} />} />
      ))}
      {loading && Array.from({ length: 3 }, (_, index) => <SkeletonListRow key={index} size={rowSize} />)}
      {failed ? <EmptyState compact title={t('新曲を読み込めませんでした')}
        action={{ label: t('再試行'), onClick: () => { setLoading(true); setRetry(value => value + 1); } }} />
        : !loading && !hasMore && visible.length === 0 ? <EmptyState compact title={t('表示できる新曲はありません')} /> : null}
      {!loading && !failed && hasMore && <div className="my-4 flex justify-center">
        <Button onClick={loadMore}>{t('さらに読み込む')}</Button>
      </div>}
    </section>
  );
}
