import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { useFavoriteProducerStore, type FavoriteProducer } from '../stores/favoriteProducerStore';
import { useLanguageStore } from '../stores/languageStore';
import { showToast } from '../stores/toastStore';
import { useTranslate, useTranslateSourceText } from '../i18n';
import { MOBILE_MEDIA_QUERY, useMediaQuery } from '../hooks/useMediaQuery';
import { artistPath } from '../utils/routes';
import { artistTypeLabel } from '../utils/songMeta';
import { formatRelativeTime } from '../utils/relativeDate';
import Button from '../components/ui/Button';
import EmptyState from '../components/ui/EmptyState';
import IconButton from '../components/ui/IconButton';
import { PageHeader, PageShell } from '../components/ui/PageHeader';
import SortMenu from '../components/ui/SortMenu';
import { CheckIcon, PersonStarFilledIcon, PersonStarIcon } from '../components/ui/icons';

type ProducerSortMode = 'added' | 'name';

/**
 * FavoriteProducersPage - お気に入りP（YouTube の登録チャンネルの一覧と同じ形）
 */
export default function FavoriteProducersPage() {
  const t = useTranslateSourceText();
  const tk = useTranslate();
  const language = useLanguageStore(state => state.language);
  const isMobile = useMediaQuery(MOBILE_MEDIA_QUERY);
  const producers = useFavoriteProducerStore(state => state.producers);
  const [sortMode, setSortMode] = useState<ProducerSortMode>('added');

  const sorted = useMemo(() => (sortMode === 'name'
    ? [...producers].sort((a, b) => a.name.localeCompare(b.name, 'ja'))
    : [...producers].sort((a, b) => b.createdAt - a.createdAt)), [producers, sortMode]);

  const remove = (producer: FavoriteProducer) => {
    const store = useFavoriteProducerStore.getState();
    const index = store.producers.findIndex(item => item.id === producer.id);
    if (index < 0) return;
    const record = store.producers[index];
    store.removeProducer(producer.id);
    showToast(t('{name}をお気に入りPから外しました', { name: producer.name }), {
      action: {
        label: t('元に戻す'),
        // Put the same record back where it was (keeps the registration date and order).
        onAction: () => useFavoriteProducerStore.setState(state => {
          if (state.producers.some(item => item.id === record.id)) return state;
          const next = [...state.producers];
          next.splice(Math.min(index, next.length), 0, record);
          return { producers: next };
        }),
      },
    });
  };

  const now = Date.now();
  const count = producers.length;

  return (
    <PageShell>
      <PageHeader
        title={t('お気に入りP')}
        meta={count > 0 ? (count === 1 ? tk('libraryProducerCountOne') : tk('libraryProducerCount', { count: count.toLocaleString() })) : undefined}
        actions={count > 1 ? (
          <SortMenu
            value={sortMode}
            options={[
              { value: 'added', label: t('登録が新しい順') },
              { value: 'name', label: t('名前順') },
            ]}
            onChange={setSortMode}
            compact={isMobile}
          />
        ) : undefined}
      />

      {count === 0 ? (
        <EmptyState icon={<PersonStarIcon />} title={tk('libraryNoFavoriteProducers')} action={{ label: t('曲を探す'), to: '/' }} />
      ) : (
        <ul className="m-0 -mx-2 list-none p-0">
          {sorted.map(producer => {
            const removeLabel = t('{producer}をお気に入りPから解除', { producer: producer.name });
            return (
              <li
                key={producer.id}
                className="relative flex min-h-16 items-center gap-3 rounded-card px-3 py-2 transition-colors duration-150 hover:bg-yt-tonal sm:gap-4"
              >
                <div className="min-w-0 flex-1">
                  <h2 className="m-0 truncate text-base leading-[22px] font-medium text-yt-text sm:text-lg sm:leading-[26px]">
                    <Link
                      to={artistPath({ id: producer.id, name: producer.name })}
                      className="text-inherit no-underline after:absolute after:inset-0 after:rounded-card after:content-[''] focus-visible:outline-none focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-yt-focus"
                    >
                      {producer.name}
                    </Link>
                  </h2>
                  <p className="m-0 mt-0.5 truncate text-xs leading-[18px] text-yt-text-secondary sm:text-sm sm:leading-5">
                    {t('{type} · {time}に登録', {
                      type: artistTypeLabel(producer.artistType, language),
                      time: formatRelativeTime(producer.createdAt, now, language),
                    })}
                  </p>
                </div>
                <div className="relative z-[1] shrink-0">
                  {isMobile ? (
                    <IconButton
                      label={removeLabel}
                      icon={<PersonStarFilledIcon />}
                      pressed
                      onClick={() => remove(producer)}
                    />
                  ) : (
                    <Button
                      aria-pressed="true"
                      aria-label={removeLabel}
                      icon={<CheckIcon />}
                      onClick={() => remove(producer)}
                    >
                      {tk('libraryFavoriteProducerPill')}
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </PageShell>
  );
}
