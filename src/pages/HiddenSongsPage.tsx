import { useEffect, useMemo, useRef, useState } from 'react';
import { useHiddenSongStore, type HiddenSongRecord } from '../stores/hiddenSongStore';
import { useLanguageStore } from '../stores/languageStore';
import { confirmDialog } from '../stores/confirmStore';
import { showToast } from '../stores/toastStore';
import { useTranslateSourceText } from '../i18n';
import { MOBILE_MEDIA_QUERY, useMediaQuery } from '../hooks/useMediaQuery';
import { formatArtistLine, formatCount } from '../utils/songMeta';
import { formatRelativeTime } from '../utils/relativeDate';
import { filterSongsByText } from '../utils/ratedSongs';
import Button from '../components/ui/Button';
import EmptyState from '../components/ui/EmptyState';
import IconButton from '../components/ui/IconButton';
import Menu, { MenuItem } from '../components/ui/Menu';
import { PageHeader, PageShell } from '../components/ui/PageHeader';
import SearchField from '../components/ui/SearchField';
import SongListRow from '../components/ui/SongListRow';
import SortMenu from '../components/ui/SortMenu';
import { EyeIcon, EyeOffIcon, MoreVertIcon } from '../components/ui/icons';

type SortMode = 'recent' | 'name';

/**
 * HiddenSongsPage - 表示しない曲（おすすめ・自動再生から外した曲。明示的な検索では今までどおり出る）
 */
export default function HiddenSongsPage() {
  const t = useTranslateSourceText();
  const language = useLanguageStore(state => state.language);
  const isMobile = useMediaQuery(MOBILE_MEDIA_QUERY);
  const hiddenSongs = useHiddenSongStore(state => state.hiddenSongs);
  const [query, setQuery] = useState('');
  const [sortMode, setSortMode] = useState<SortMode>('recent');

  const allRecords = useMemo(() => Object.values(hiddenSongs), [hiddenSongs]);
  const records = useMemo(() => {
    const matchingIds = new Set(filterSongsByText(allRecords.map(record => record.song), query).map(song => song.id));
    return allRecords
      .filter(record => matchingIds.has(record.song.id))
      .sort((a, b) => sortMode === 'name'
        ? a.song.name.localeCompare(b.song.name, 'ja')
        : b.hiddenAt - a.hiddenAt);
  }, [allRecords, query, sortMode]);

  // The pressed 再表示 leaves with its row: keyboard and screen reader users continue from the next row
  // (the previous one at the end), or from the empty state when nothing is left.
  const unhideButtons = useRef(new Map<number, HTMLButtonElement>());
  const emptyRef = useRef<HTMLDivElement>(null);
  const pendingFocus = useRef<number | 'empty' | null>(null);
  useEffect(() => {
    const target = pendingFocus.current;
    if (target === null) return;
    pendingFocus.current = null;
    const element = target === 'empty' ? emptyRef.current : unhideButtons.current.get(target);
    element?.focus();
  });

  const unhide = (record: HiddenSongRecord) => {
    const index = records.findIndex(item => item.song.id === record.song.id);
    const neighbour = records[index + 1] ?? records[index - 1];
    pendingFocus.current = neighbour ? neighbour.song.id : 'empty';
    useHiddenSongStore.getState().restoreSong(record.song.id);
    showToast(t('再表示しました'), {
      action: {
        label: t('元に戻す'),
        // Restore the same record so the song keeps its original "hidden" time.
        onAction: () => useHiddenSongStore.setState(state => ({
          hiddenSongs: { ...state.hiddenSongs, [String(record.song.id)]: record },
        })),
      },
    });
  };

  const unhideAll = async () => {
    const confirmed = await confirmDialog({ title: t('すべての曲を再表示しますか？'), confirmLabel: t('再表示') });
    if (!confirmed) return;
    pendingFocus.current = 'empty';
    useHiddenSongStore.getState().replaceHiddenSongs({});
    showToast(t('再表示しました'));
  };

  const count = allRecords.length;
  const now = Date.now();

  return (
    <PageShell>
      <PageHeader
        title={t('表示しない曲')}
        meta={count > 0
          ? `${formatCount(count, 'song', language)} · ${t('おすすめと自動再生に表示されません')}`
          : undefined}
        actions={count > 0 ? (
          <>
            <SearchField expandable value={query} onChange={setQuery} label={t('表示しない曲を検索')} width={isMobile ? 200 : 240} />
            <SortMenu
              value={sortMode}
              options={[
                { value: 'recent', label: t('新しい順') },
                { value: 'name', label: t('曲名順') },
              ]}
              onChange={setSortMode}
              compact={isMobile}
            />
            <Menu trigger={<IconButton label={t('その他の操作')} icon={<MoreVertIcon />} />} align="end">
              <MenuItem icon={<EyeIcon />} onSelect={() => void unhideAll()}>{t('すべて再表示')}</MenuItem>
            </Menu>
          </>
        ) : undefined}
      />

      {count === 0 || records.length === 0 ? (
        <div ref={emptyRef} tabIndex={-1} className="outline-none">
          {count === 0
            ? <EmptyState icon={<EyeOffIcon />} title={t('表示しない曲はありません')} />
            : <EmptyState compact title={t('一致する曲はありません')} />}
        </div>
      ) : (
        <div className="-mx-2">
          {records.map(record => (
            <SongListRow
              key={record.song.id}
              song={record.song}
              size={isMobile ? 'sm' : 'md'}
              meta={[
                `${formatArtistLine(record.song)} · ${t('{time}に非表示', { time: formatRelativeTime(record.hiddenAt, now, language) })}`,
              ]}
              trailing={(
                <Button
                  ref={element => {
                    if (element) unhideButtons.current.set(record.song.id, element);
                    else unhideButtons.current.delete(record.song.id);
                  }}
                  icon={isMobile ? undefined : <EyeIcon />}
                  className="max-sm:h-10"
                  onClick={() => unhide(record)}
                >
                  {t('再表示')}
                </Button>
              )}
            />
          ))}
        </div>
      )}
    </PageShell>
  );
}
