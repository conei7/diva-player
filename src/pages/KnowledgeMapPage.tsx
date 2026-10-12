import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  fetchKnowledgeMap,
  type KnowledgeMapPlatform,
  type KnowledgeMapResponse,
  type PlatformKnowledgeMap,
} from '../api/knowledgeMap';
import { translateSourceText, useTranslateSourceText } from '../i18n';
import { getPlayedSongIds } from '../services/historyDatabase';
import { useLanguageStore } from '../stores/languageStore';
import { useRatingStore } from '../stores/ratingStore';
import { showToast } from '../stores/toastStore';
import { buildKnowledgeMapItems, capKnowledgeMapSongTiles, formatKnowledgePercent } from '../utils/knowledgeMap';
import { getRatedSongIds } from '../utils/ratedSongs';
import { formatCompactCount, serviceLabel } from '../utils/songMeta';
import { Chip } from '../components/ui/Chip';
import EmptyState from '../components/ui/EmptyState';
import InfoTip from '../components/ui/InfoTip';
import { PageHeader, PageShell } from '../components/ui/PageHeader';
import { SkeletonBlock, SkeletonListRow } from '../components/ui/Skeleton';
import { ErrorIcon } from '../components/ui/icons';
import DiscoveryMixAction from '../components/discovery/DiscoveryMixAction';
import KnowledgeRanking from '../components/discovery/KnowledgeRanking';
import KnowledgeTreemap, { type KnowledgeViewMode } from '../components/discovery/KnowledgeTreemap';
import { useSongsById } from '../components/discovery/discoverySongs';
import { KNOWLEDGE_MAP_COLORS, KNOWN_SERVICE_COLOR } from '../components/discovery/mapColors';

const RANKING_SIZE = 8;

function topTiles(data: PlatformKnowledgeMap | null, known: boolean): PlatformKnowledgeMap['tiles'] {
  return data?.tiles
    .filter(tile => tile.known === known)
    .sort((left, right) => right.views - left.views)
    .slice(0, RANKING_SIZE) ?? [];
}

export default function KnowledgeMapPage() {
  const t = useTranslateSourceText();
  const language = useLanguageStore(state => state.language);
  const ratings = useRatingStore(state => state.ratings);
  const [result, setResult] = useState<KnowledgeMapResponse | null>(null);
  const [platform, setPlatform] = useState<KnowledgeMapPlatform>('youtube');
  const [viewMode, setViewMode] = useState<KnowledgeViewMode>('all');
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const ratedSongIds = useMemo(() => getRatedSongIds(ratings), [ratings]);
  const hasResultRef = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setLoading(true);
    setFailed(false);
    getPlayedSongIds()
      .then(playedSongIds => {
        // Explicit ratings stay inside the API's 50,000-id limit even for an
        // unusually large playback history; overlapping IDs still count once.
        const knownSongIds = new Set(ratedSongIds);
        playedSongIds.forEach(id => knownSongIds.add(id));
        return fetchKnowledgeMap(knownSongIds, controller.signal);
      })
      .then(next => {
        if (!active) return;
        hasResultRef.current = true;
        setResult(next);
      })
      .catch(requestError => {
        if (!active || !(requestError instanceof Error) || requestError.name === 'AbortError') return;
        setFailed(true);
        if (hasResultRef.current) {
          // The previous map stays on screen.
          const currentLanguage = useLanguageStore.getState().language;
          showToast(translateSourceText(currentLanguage, '更新できませんでした'), {
            action: { label: translateSourceText(currentLanguage, '再試行'), onAction: () => setReloadKey(key => key + 1) },
          });
        }
      })
      .finally(() => { if (active) setLoading(false); });
    return () => {
      active = false;
      controller.abort();
    };
  }, [ratedSongIds, reloadKey]);

  const data = result?.[platform] ?? null;
  const allItems = useMemo(() => (data ? buildKnowledgeMapItems(data) : []), [data]);
  const mapItems = useMemo(
    () => capKnowledgeMapSongTiles(viewMode === 'all'
      ? allItems
      : allItems.filter(item => (viewMode === 'known' ? item.known : !item.known))),
    [allItems, viewMode],
  );
  const topUnknown = useMemo(() => topTiles(data, false), [data]);
  const topKnown = useMemo(() => topTiles(data, true), [data]);
  const songIds = useMemo(
    () => [
      ...topUnknown.map(tile => tile.songId),
      ...topKnown.map(tile => tile.songId),
      ...mapItems.flatMap(item => (item.songId === undefined ? [] : [item.songId])),
    ],
    [mapItems, topKnown, topUnknown],
  );
  const songsById = useSongsById(songIds);
  const retry = useCallback(() => setReloadKey(key => key + 1), []);

  const service = (value: KnowledgeMapPlatform) => serviceLabel(value === 'youtube' ? 'Youtube' : 'NicoNicoDouga', language);
  const count = (value: number) => value.toLocaleString(language === 'ja' ? 'ja-JP' : 'en-US');
  const showSkeleton = loading && !result;

  return (
    <PageShell className="pb-8">
      <div data-testid="knowledge-map-page" aria-busy={showSkeleton || undefined}>
        <PageHeader
          title={t('知ってる度')}
          meta={(
            <span className="relative inline-flex h-5 items-center align-top sm:-top-0.5">
              <InfoTip label={t('このマップについて')}>
                <p className="m-0">{t('再生した曲と星をつけた曲を「知っている曲」として数えます')}</p>
                <p className="m-0 mt-2">{t('面積は再生数です。YouTube とニコニコは別々に集計します')}</p>
                <p className="m-0 mt-2">{t('送信するのは曲IDだけで、保存されません。星の数は送りません')}</p>
                {result && (
                  <p className="m-0 mt-2 text-xs leading-[18px] text-yt-text-secondary tabular-nums">
                    {t('対象 {eligible}曲 · 一致 {matched} / {history}曲', {
                      eligible: count(result.eligibleSongCount),
                      matched: count(result.matchedHistorySongCount),
                      history: count(result.historySongCount),
                    })}
                  </p>
                )}
              </InfoTip>
            </span>
          )}
        />

        {failed && !result ? (
          <div role="alert" className="rounded-card bg-yt-raised">
            <EmptyState icon={<ErrorIcon />} title={t('知ってる度を読み込めませんでした')} action={{ label: t('再試行'), onClick: retry }} />
          </div>
        ) : showSkeleton || !data ? (
          <KnowledgeMapSkeleton label={t('読み込み中…')} />
        ) : (
          <>
            <section aria-label={t('知ってる度')} className="mb-6">
              {data.knownSongCount === 0 ? (
                <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
                  <p className="m-0 text-base font-medium leading-6 text-yt-text">{t('まだ知っている曲がありません')}</p>
                  <DiscoveryMixAction />
                </div>
              ) : (
                <>
                  <p className="m-0 text-4xl font-bold leading-[44px] text-yt-text sm:text-5xl sm:leading-[56px]">
                    {formatKnowledgePercent(data.coverageRatio)}
                  </p>
                  <div
                    aria-hidden="true"
                    className="mt-3 h-1 w-full max-w-[360px] overflow-hidden rounded-full"
                    style={{ backgroundColor: KNOWLEDGE_MAP_COLORS.meterTrack }}
                  >
                    <div
                      className="h-full rounded-full"
                      style={{
                        width: `${Math.max(0, Math.min(1, data.coverageRatio)) * 100}%`,
                        backgroundColor: KNOWN_SERVICE_COLOR[platform],
                      }}
                    />
                  </div>
                </>
              )}
              <p className="m-0 mt-3 text-sm leading-5 text-yt-text-secondary tabular-nums">
                {t('{known} / {total}曲 · 再生数 {knownViews} / {totalViews}回', {
                  known: count(data.knownSongCount),
                  total: count(data.totalSongCount),
                  knownViews: formatCompactCount(data.knownViews, language),
                  totalViews: formatCompactCount(data.totalViews, language),
                })}
              </p>
            </section>

            <div className="mb-3 flex flex-wrap items-center gap-3">
              <div role="group" aria-label={t('再生数のサービス')} className="grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto sm:gap-3">
                {(['youtube', 'nico'] as const).map(value => (
                  <Chip
                    key={value}
                    selected={platform === value}
                    onClick={() => setPlatform(value)}
                    className="justify-center"
                  >
                    {service(value)}
                  </Chip>
                ))}
              </div>
              <span aria-hidden="true" className="hidden h-6 w-px bg-yt-divider sm:block" />
              <div role="group" aria-label={t('マップ表示')} className="flex min-w-0 max-w-full gap-2 overflow-x-auto [scrollbar-width:none] sm:gap-3 [&::-webkit-scrollbar]:hidden">
                <Chip selected={viewMode === 'all'} onClick={() => setViewMode('all')}>{t('すべて')}</Chip>
                <Chip
                  selected={viewMode === 'known'}
                  onClick={() => setViewMode('known')}
                  icon={<span className="block size-2.5 rounded-full" style={{ backgroundColor: KNOWN_SERVICE_COLOR[platform] }} />}
                >
                  {t('知っている曲')}
                </Chip>
                <Chip
                  selected={viewMode === 'unknown'}
                  onClick={() => setViewMode('unknown')}
                  icon={<span className="block size-2.5 rounded-full border-[1.5px] border-current opacity-70" />}
                >
                  {t('まだ知らない曲')}
                </Chip>
              </div>
            </div>

            <KnowledgeTreemap
              key={`${platform}-${viewMode}`}
              platform={platform}
              items={mapItems}
              viewMode={viewMode}
              songsById={songsById}
              totalViews={data.totalViews}
            />

            <div className="mt-8 grid min-w-0 gap-8 xl:grid-cols-2 xl:gap-6">
              <KnowledgeRanking
                title={t('まだ知らない人気曲')}
                headingId="knowledge-map-unknown-heading"
                tiles={topUnknown}
                empty={t('人気曲はすべて知っています')}
                songsById={songsById}
                playSource="discovery"
              />
              <KnowledgeRanking
                title={t('知っている人気曲')}
                headingId="knowledge-map-known-heading"
                tiles={topKnown}
                empty={t('まだありません')}
                songsById={songsById}
                playSource="manual"
              />
            </div>
          </>
        )}
      </div>
    </PageShell>
  );
}

function KnowledgeMapSkeleton({ label }: { label: string }) {
  return (
    <div>
      <span className="sr-only">{label}</span>
      <SkeletonBlock className="h-12 w-36 rounded-badge" />
      <SkeletonBlock className="mt-3 h-1 w-full max-w-[360px] rounded-full" />
      <SkeletonBlock className="mt-3 mb-6 h-4 w-64 max-w-full rounded-badge" />
      <div className="mb-3 flex gap-3">
        {[0, 1, 2, 3, 4].map(index => <SkeletonBlock key={index} className="h-10 w-20 rounded-chip sm:h-8" />)}
      </div>
      <SkeletonBlock className="h-[clamp(360px,60vh,560px)] w-full rounded-card max-sm:-mx-3 max-sm:h-80 max-sm:w-auto max-sm:rounded-none" />
      <SkeletonBlock className="mt-2 h-10 w-full rounded-card max-sm:-mx-3 max-sm:w-auto max-sm:rounded-none" />
      <div className="mt-8 grid gap-8 xl:grid-cols-2 xl:gap-6">
        {[0, 1].map(column => (
          <div key={column}>
            <SkeletonBlock className="mb-3 h-6 w-48 rounded-badge" />
            {[0, 1, 2, 3].map(row => <SkeletonListRow key={row} size="sm" />)}
          </div>
        ))}
      </div>
    </div>
  );
}
