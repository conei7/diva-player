/**
 * SelectionFAB.tsx
 *
 * 複数選択モードの文脈バー（上部に固定）と「条件で選択」ダイアログ。
 * [×] 「{n}曲を選択中」 [すべて選択] … [キューに追加] [プレイリストに保存] [⋮]
 * export 名・props・data-testid="selection-fab" は Layout と e2e のために変えない。
 */

import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import type { Song } from '../../types/vocadb';
import { useSelectionStore } from '../../stores/selectionStore';
import { usePlayerStore } from '../../stores/playerStore';
import { useUiStore } from '../../stores/uiStore';
import { showToast } from '../../stores/toastStore';
import { useTranslateSourceText } from '../../i18n';
import { MOBILE_MEDIA_QUERY, useMediaQuery } from '../../hooks/useMediaQuery';
import { SelectionBar } from '../ui/SelectionBar';
import Button from '../ui/Button';
import IconButton from '../ui/IconButton';
import Dialog from '../ui/Dialog';
import { Chip } from '../ui/Chip';
import SearchField from '../ui/SearchField';
import { MenuItem } from '../ui/Menu';
import { CloseIcon, CopyIcon, PlaylistAddIcon, QueueMusicIcon, TuneIcon } from '../ui/icons';

// ─── 条件で選択 ───────────────────────────────────────────────────────────────

type MatchTarget = 'title' | 'artist' | 'tag';

function matchesKeyword(song: Song, target: MatchTarget, keyword: string, caseSensitive: boolean): boolean {
  const needle = caseSensitive ? keyword : keyword.toLowerCase();
  if (!needle.trim()) return true;
  const haystack = target === 'title'
    ? song.name
    : target === 'artist'
      ? song.artistString ?? ''
      : (song.tags ?? []).map(tag => tag.tag.name).join(' ');
  return (caseSensitive ? haystack : haystack.toLowerCase()).includes(needle);
}

/** Mounted only while open, so every opening starts from an empty keyword. */
function SelectMatchingDialog({ songs, onClose }: { songs: Song[]; onClose: () => void }) {
  const t = useTranslateSourceText();
  const caseId = useId();
  const [target, setTarget] = useState<MatchTarget>('title');
  const [keyword, setKeyword] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const selectAll = useSelectionStore(state => state.selectAll);
  const matched = useMemo(
    () => (keyword.trim() ? songs.filter(song => matchesKeyword(song, target, keyword, caseSensitive)) : []),
    [caseSensitive, keyword, songs, target],
  );

  const apply = () => {
    if (matched.length > 0) selectAll(matched);
    onClose();
  };

  const targets: { value: MatchTarget; label: string }[] = [
    { value: 'title', label: t('タイトル') },
    { value: 'artist', label: t('アーティスト') },
    { value: 'tag', label: t('タグ') },
  ];

  return (
    <Dialog
      open
      onClose={onClose}
      title={t('条件で選択')}
      size="sm"
      footer={(
        <>
          <Button variant="ghost" onClick={onClose}>{t('キャンセル')}</Button>
          <Button variant="primary" disabled={matched.length === 0} onClick={apply}>
            {matched.length === 1 ? t('1曲を選択') : t('{count}曲を選択', { count: matched.length })}
          </Button>
        </>
      )}
    >
      <div className="flex flex-col gap-4 pt-1">
        <div role="group" aria-label={t('対象')} className="flex flex-wrap gap-2">
          {targets.map(option => (
            <Chip key={option.value} selected={target === option.value} onClick={() => setTarget(option.value)}>
              {option.label}
            </Chip>
          ))}
        </div>
        <SearchField value={keyword} onChange={setKeyword} label={t('キーワード')} autoFocus onSubmit={apply} />
        <label htmlFor={caseId} className="flex min-h-10 cursor-pointer select-none items-center gap-3 text-sm leading-5 text-yt-text">
          <input
            id={caseId}
            type="checkbox"
            checked={caseSensitive}
            onChange={event => setCaseSensitive(event.target.checked)}
            className="h-[18px] w-[18px] shrink-0 cursor-pointer accent-yt-link"
          />
          {t('大文字と小文字を区別')}
        </label>
      </div>
    </Dialog>
  );
}

// ─── 選択バー ──────────────────────────────────────────────────────────────

interface SelectionFABProps {
  /** 現在の画面に表示されている全曲（すべて選択・条件で選択の対象） */
  visibleSongs: Song[];
}

export default function SelectionFAB({ visibleSongs }: SelectionFABProps) {
  const t = useTranslateSourceText();
  const isSelectionMode = useSelectionStore(state => state.isSelectionMode);
  const selectedSongIds = useSelectionStore(state => state.selectedSongIds);
  const selectedSongs = useSelectionStore(state => state.selectedSongs);
  const exitSelectionMode = useSelectionStore(state => state.exitSelectionMode);
  const selectAll = useSelectionStore(state => state.selectAll);
  const clearSelection = useSelectionStore(state => state.clearSelection);
  const addManyToQueue = usePlayerStore(state => state.addManyToQueue);
  const openSaveToPlaylist = useUiStore(state => state.openSaveToPlaylist);
  const isMobile = useMediaQuery(MOBILE_MEDIA_QUERY);
  const [matchingDialogOpen, setMatchingDialogOpen] = useState(false);

  // Esc closes only the top layer (DESIGN_SPEC §6.5.4): a menu, a dialog, the queue or the guide
  // drawer first, selection mode after them. The listener is on window, so the document-level
  // handlers of those layers run first and their preventDefault is already visible here.
  useEffect(() => {
    if (!isSelectionMode) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return;
      if (document.querySelector('[aria-modal="true"]')) return;
      exitSelectionMode();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [isSelectionMode, exitSelectionMode]);

  // The bar covers the toggle that opened it: keyboard focus moves to the bar's 選択を解除 (×) and
  // returns to the toggle when selection mode ends.
  useEffect(() => {
    if (!isSelectionMode) return;
    const opener = document.activeElement instanceof HTMLElement && document.activeElement !== document.body
      ? document.activeElement
      : null;
    document.querySelector<HTMLElement>('[data-testid="selection-fab"] button')?.focus({ preventScroll: true });
    return () => {
      // Only when focus was in the bar (it is gone now); a click elsewhere keeps its own focus.
      if (document.activeElement && document.activeElement !== document.body) return;
      const target = opener?.isConnected && opener.closest('[inert]') === null
        ? opener
        : document.querySelector<HTMLElement>('[data-selection-toggle]');
      target?.focus({ preventScroll: true });
    };
  }, [isSelectionMode]);

  // 選択時点のSongオブジェクトを使う。表示タブや絞り込みが変わっても選択を維持する。
  const getSelectedSongs = useCallback((): Song[] => [...selectedSongs.values()], [selectedSongs]);

  const handleAddToQueue = useCallback(() => {
    const songs = getSelectedSongs();
    if (songs.length === 0) return;
    addManyToQueue(songs);
    if (!usePlayerStore.getState().queueDrawerOpen) usePlayerStore.getState().toggleQueueDrawer();
    showToast(t('キューに追加しました'));
  }, [addManyToQueue, getSelectedSongs, t]);

  const handleSaveToPlaylist = useCallback(() => {
    const songs = getSelectedSongs();
    if (songs.length === 0) return;
    openSaveToPlaylist(songs);
  }, [getSelectedSongs, openSaveToPlaylist]);

  const handleCopyIds = useCallback(() => {
    const ids = [...selectedSongIds].join(', ');
    if (!navigator.clipboard?.writeText) {
      showToast(t('コピーできませんでした'));
      return;
    }
    navigator.clipboard.writeText(ids)
      .then(() => showToast(t('曲IDをコピーしました')))
      .catch(() => showToast(t('コピーできませんでした')));
  }, [selectedSongIds, t]);

  if (!isSelectionMode) return null;

  const selectedCount = selectedSongIds.size;
  const nothingSelected = selectedCount === 0;

  return (
    <>
      <SelectionBar
        data-testid="selection-fab"
        count={selectedCount}
        onClose={exitSelectionMode}
        onSelectAll={() => selectAll(visibleSongs)}
        overflow={(
          <>
            <MenuItem icon={<TuneIcon />} onSelect={() => setMatchingDialogOpen(true)}>{t('条件で選択')}</MenuItem>
            <MenuItem icon={<CopyIcon />} disabled={nothingSelected} onSelect={handleCopyIds}>{t('曲IDをコピー')}</MenuItem>
            <MenuItem icon={<CloseIcon />} disabled={nothingSelected} onSelect={clearSelection}>{t('選択を解除')}</MenuItem>
          </>
        )}
      >
        {isMobile ? (
          <>
            <IconButton label={t('キューに追加')} icon={<QueueMusicIcon />} disabled={nothingSelected} onClick={handleAddToQueue} />
            <IconButton label={t('プレイリストに保存')} icon={<PlaylistAddIcon />} disabled={nothingSelected} onClick={handleSaveToPlaylist} />
          </>
        ) : (
          <>
            <Button icon={<QueueMusicIcon />} disabled={nothingSelected} onClick={handleAddToQueue}>
              {t('キューに追加')}
            </Button>
            <Button variant="primary" icon={<PlaylistAddIcon />} disabled={nothingSelected} onClick={handleSaveToPlaylist}>
              {t('プレイリストに保存')}
            </Button>
          </>
        )}
      </SelectionBar>

      {matchingDialogOpen && (
        <SelectMatchingDialog songs={visibleSongs} onClose={() => setMatchingDialogOpen(false)} />
      )}
    </>
  );
}
