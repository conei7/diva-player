import { useMemo, useState } from 'react';
import type { Song } from '../../types/vocadb';
import { useTranslateSourceText } from '../../i18n';
import {
  analyzePlaylistHealth,
  PLAYLIST_HEALTH_ISSUE_LABELS,
  PLAYLIST_HEALTH_ISSUE_ORDER,
  type PlaylistHealthIssueKind,
} from '../../utils/playlistHealth';
import { formatArtistLine } from '../../utils/songMeta';
import Button from '../ui/Button';
import { Chip, ChipBar } from '../ui/Chip';
import Dialog from '../ui/Dialog';
import EmptyState from '../ui/EmptyState';
import SongThumbnail from '../ui/SongThumbnail';
import { CheckBoxIcon, CheckBoxOutlineIcon, CheckCircleIcon } from '../ui/icons';

interface PlaylistHealthModalProps {
  songs: Song[];
  onClose: () => void;
  /** Saved positions of the songs to remove (ascending). */
  onRemove: (indexes: number[]) => void;
}

/** 曲のチェック: duplicates and songs without a playable video; pick which ones to remove. */
export default function PlaylistHealthModal({ songs, onClose, onRemove }: PlaylistHealthModalProps) {
  const t = useTranslateSourceText();
  const report = useMemo(() => analyzePlaylistHealth(songs), [songs]);
  const [kindFilter, setKindFilter] = useState<PlaylistHealthIssueKind | null>(null);
  const [selectedIndexes, setSelectedIndexes] = useState<Set<number>>(
    () => new Set(report.entries.map(entry => entry.index)),
  );
  const kinds = PLAYLIST_HEALTH_ISSUE_ORDER.filter(kind => report.counts[kind] > 0);
  const shown = kindFilter ? report.entries.filter(entry => entry.issues.includes(kindFilter)) : report.entries;
  // With a kind chip on, only the checked rows on screen are counted and removed (the hidden
  // ones keep their checks for when the chip is turned off).
  const targets = shown.filter(entry => selectedIndexes.has(entry.index)).map(entry => entry.index).sort((a, b) => a - b);
  const count = targets.length;

  const toggle = (index: number) => {
    setSelectedIndexes(current => {
      const next = new Set(current);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };
  const setShown = (checked: boolean) => {
    setSelectedIndexes(current => {
      const next = new Set(current);
      shown.forEach(entry => (checked ? next.add(entry.index) : next.delete(entry.index)));
      return next;
    });
  };

  const hasIssues = report.entries.length > 0;

  return (
    <Dialog
      open
      onClose={onClose}
      title={t('曲のチェック')}
      size="md"
      footerStart={hasIssues ? (
        <>
          <Button variant="text" size="sm" onClick={() => setShown(true)}>{t('すべて選択')}</Button>
          <Button variant="text" size="sm" onClick={() => setShown(false)}>{t('すべて解除')}</Button>
        </>
      ) : undefined}
      footer={hasIssues ? (
        <>
          <Button variant="ghost" onClick={onClose}>{t('キャンセル')}</Button>
          <Button
            variant="primary"
            disabled={count === 0}
            onClick={() => onRemove(targets)}
          >
            {count === 1 ? t('1曲を削除') : t('{count}曲を削除', { count })}
          </Button>
        </>
      ) : undefined}
    >
      {!hasIssues ? (
        <EmptyState compact icon={<CheckCircleIcon />} title={t('問題は見つかりませんでした')} />
      ) : (
        <>
          <ChipBar label={t('問題の種類')} className="[--chipbar-fade:var(--color-yt-raised)]">
            {kinds.map(kind => (
              <Chip
                key={kind}
                selected={kindFilter === kind}
                count={report.counts[kind]}
                onClick={() => setKindFilter(current => (current === kind ? null : kind))}
              >
                {t(PLAYLIST_HEALTH_ISSUE_LABELS[kind])}
              </Chip>
            ))}
          </ChipBar>
          <ul className="m-0 mt-3 list-none p-0">
            {shown.map(entry => {
              const checked = selectedIndexes.has(entry.index);
              return (
                <li key={`${entry.song.id}-${entry.index}`}>
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={checked}
                    onClick={() => toggle(entry.index)}
                    className="-mx-2 flex w-[calc(100%+16px)] cursor-pointer items-center gap-3 rounded-chip px-2 py-2 text-left transition-colors duration-150 hover:bg-yt-tonal"
                  >
                    <span aria-hidden="true" className="flex shrink-0">
                      {checked ? <CheckBoxIcon className="text-yt-link" /> : <CheckBoxOutlineIcon className="text-yt-text-secondary" />}
                    </span>
                    <SongThumbnail song={entry.song} className="w-16" radius="sm" showDuration={false} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium leading-5 text-yt-text">{entry.song.name}</span>
                      <span className="mt-0.5 flex min-w-0 flex-wrap items-center gap-1 text-xs leading-[18px] text-yt-text-secondary">
                        <span className="min-w-0 truncate">{formatArtistLine(entry.song)}</span>
                        {entry.issues.map(kind => (
                          <span key={kind} className="shrink-0 rounded-badge bg-yt-tonal px-1.5 text-xs leading-5 text-yt-text">
                            {t(PLAYLIST_HEALTH_ISSUE_LABELS[kind])}
                          </span>
                        ))}
                      </span>
                    </span>
                    <span className="shrink-0 text-xs text-yt-text-secondary tabular-nums">#{entry.index + 1}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </Dialog>
  );
}
