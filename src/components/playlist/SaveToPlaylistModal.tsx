import { useAsyncAction } from '../../hooks/useAsyncAction';
/**
 * SaveToPlaylistModal — 「保存先…」 (YouTube's "Save to…").
 * Shown while uiStore.saveToPlaylistSongs is set (mounted by Layout). Checking a playlist saves
 * at once and unchecking removes; the result is a toast, not text inside the dialog.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Playlist, Song } from '../../types/vocadb';
import { useTranslateSourceText } from '../../i18n';
import { useLanguageStore } from '../../stores/languageStore';
import { usePlaylistStore, WATCH_LATER_ID } from '../../stores/playlistStore';
import { showToast } from '../../stores/toastStore';
import { useUiStore, type SaveToPlaylistContext } from '../../stores/uiStore';
import { displayPlaylistName } from '../../utils/displayNames';
import { isSyncedPlaylist } from '../../utils/playlistPermissions';
import { getQueueSongsForScope, type QueueSaveScope } from '../../utils/queuePlaylist';
import { formatCount } from '../../utils/songMeta';
import Button from '../ui/Button';
import { Chip } from '../ui/Chip';
import Dialog from '../ui/Dialog';
import Tooltip from '../ui/Tooltip';
import { AddIcon, CheckBoxIcon, CheckBoxOutlineIcon, SyncIcon, TuneIcon } from '../ui/icons';
import { cx } from '../ui/overlay';
import { PLAYLIST_FIELD_CLASS } from './playlistDisplay';

function IndeterminateCheckBoxIcon({ className }: { className?: string }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" width={24} height={24} fill="currentColor" className={cx('shrink-0', className)}>
      <path d="M19 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2Zm-2 10H7v-2h10v2Z" />
    </svg>
  );
}

const QUEUE_SCOPES: QueueSaveScope[] = ['currentAndRemaining', 'remaining', 'all'];

/** 後で聴く first, then the most recently updated. */
function byDialogOrder(a: Playlist, b: Playlist): number {
  if (a.id === WATCH_LATER_ID) return -1;
  if (b.id === WATCH_LATER_ID) return 1;
  return b.updatedAt - a.updatedAt;
}

/**
 * The row order is fixed when the dialog opens: saving to a list updates it, and moving it to the
 * top under the pointer would make the next press hit another list. Lists that appear while the
 * dialog is open go right after 後で聴く.
 */
function extendOrder(order: string[], playlists: Playlist[]): string[] {
  const known = new Set(order);
  const fresh = playlists.filter(playlist => !known.has(playlist.id)).sort(byDialogOrder).map(playlist => playlist.id);
  if (fresh.length === 0) return order;
  const watchLater = order[0] === WATCH_LATER_ID || fresh[0] === WATCH_LATER_ID ? [WATCH_LATER_ID] : [];
  return [
    ...watchLater,
    ...fresh.filter(id => id !== WATCH_LATER_ID),
    ...order.filter(id => id !== WATCH_LATER_ID),
  ];
}

export function SaveToPlaylistModal() {
  const t = useTranslateSourceText();
  const language = useLanguageStore(state => state.language);
  const songs = useUiStore(state => state.saveToPlaylistSongs);
  const context = useUiStore(state => state.saveToPlaylistContext);
  const close = useUiStore(state => state.closeSaveToPlaylist);
  const { busy: saving, run: runSave } = useAsyncAction();
  const playlists = usePlaylistStore(state => state.playlists);
  const loadPlaylists = usePlaylistStore(state => state.loadPlaylists);

  const [queueScope, setQueueScope] = useState<QueueSaveScope>('currentAndRemaining');
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');

  useEffect(() => {
    if (!songs || songs.length === 0) return;
    // Only when nothing is loaded yet: re-reading would replace every playlist object (an open
    // playlist page would then drop its selection).
    if (usePlaylistStore.getState().playlists.length === 0) void loadPlaylists().catch(() => undefined);
    setQueueScope('currentAndRemaining');
    setCreating(false);
    setNewName('');
  }, [songs, loadPlaylists, context.source, context.queueIndex]);

  const fromQueue = context.source === 'queue';
  const selectedSongs = useMemo<Song[]>(() => {
    if (!songs) return [];
    return fromQueue ? getQueueSongsForScope(songs, context.queueIndex ?? -1, queueScope) : songs;
  }, [context.queueIndex, fromQueue, queueScope, songs]);

  // Rows keep the order they had when the dialog opened (see extendOrder). Reset on close.
  const orderRef = useRef<{ songs: Song[] | null; ids: string[] }>({ songs: null, ids: [] });
  if (orderRef.current.songs !== songs) orderRef.current = { songs, ids: [] };
  if (songs) orderRef.current.ids = extendOrder(orderRef.current.ids, playlists);
  const order = orderRef.current.ids;

  const rows = useMemo(() => {
    const rank = new Map(order.map((id, index) => [id, index]));
    return playlists
      .filter(playlist => playlist.id !== context.excludePlaylistId)
      .sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0))
      .map(playlist => {
        const ids = new Set(playlist.songs.map(song => song.id));
        const included = selectedSongs.filter(song => ids.has(song.id)).length;
        return { playlist, included };
      });
  }, [context.excludePlaylistId, order, playlists, selectedSongs]);

  if (!songs || songs.length === 0) return null;

  const reopen = (reopenSongs: Song[], reopenContext: SaveToPlaylistContext) => () => {
    useUiStore.getState().openSaveToPlaylist(reopenSongs, reopenContext);
  };
  const changeAction = { label: t('変更'), onAction: reopen(songs, context) };

  const savedToast = (name: string, added: number, duplicates: number) => {
    if (added === 0) {
      showToast(duplicates === 1 ? t('1曲は追加済みです') : t('{count}曲は追加済みです', { count: duplicates }));
      return;
    }
    if (selectedSongs.length === 1) {
      showToast(t('「{name}」に保存しました', { name }), { action: changeAction });
      return;
    }
    let message: string;
    if (duplicates > 0) {
      message = added === 1
        ? t('1曲を「{name}」に保存しました（{duplicates}曲は追加済み）', { name, duplicates })
        : t('{count}曲を「{name}」に保存しました（{duplicates}曲は追加済み）', { count: added, name, duplicates });
    } else {
      message = added === 1
        ? t('1曲を「{name}」に保存しました', { name })
        : t('{count}曲を「{name}」に保存しました', { count: added, name });
    }
    showToast(message, { action: changeAction });
  };

  const toggle = async (playlist: Playlist, checked: boolean) => {
    if (selectedSongs.length === 0) return;
    const name = displayPlaylistName(playlist, t);
    try {
      const store = usePlaylistStore.getState();
      if (checked && !fromQueue) {
        for (const song of selectedSongs) await store.removeSongById(playlist.id, song.id);
        showToast(t('「{name}」から削除しました', { name }));
        return;
      }
      const result = (await store.addSongs(playlist.id, selectedSongs));
      if (!result.success) {
        showToast(t('保存できませんでした'));
        return;
      }
      savedToast(name, result.added, result.duplicates);
    } catch {
      // The playlist store reports storage failures itself.
    }
  };

  const createAndSave = async () => {
    const name = newName.trim();
    if (!name || selectedSongs.length === 0) return;
    try {
      const playlist = (await usePlaylistStore.getState().createPlaylistWithSongs(name, selectedSongs));
      close();
      const count = playlist.songs.length;
      showToast(count === 1
        ? t('「{name}」に保存しました', { name: playlist.name })
        : t('{count}曲を「{name}」に保存しました', { count, name: playlist.name }));
    } catch {
      // Reported by the playlist store.
    }
  };

  const scopeLabel = (scope: QueueSaveScope) => {
    const count = getQueueSongsForScope(songs, context.queueIndex ?? -1, scope).length;
    if (scope === 'currentAndRemaining') return t('再生中から（{count}）', { count });
    if (scope === 'remaining') return t('次の曲から（{count}）', { count });
    return t('すべて（{count}）', { count });
  };

  return (
    <Dialog
      open
      onClose={close}
      title={t('保存先…')}
      size="sm"
      mobile="sheet"
      data-testid="save-to-playlist-dialog"
      footer={creating ? (
        <form
          className="flex min-w-0 flex-1 items-center gap-2"
          onSubmit={event => {
            event.preventDefault();
            void runSave(createAndSave);
          }}
        >
          <input
            className={cx(PLAYLIST_FIELD_CLASS, 'min-w-0 flex-1')}
            value={newName}
            onChange={event => setNewName(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Escape' && !event.nativeEvent.isComposing) {
                event.preventDefault();
                setCreating(false);
              }
            }}
            placeholder={t('タイトルを入力')}
            aria-label={t('タイトル')}
            maxLength={150}
            autoFocus
          />
          <Button type="submit" variant="primary" size="sm" loading={saving} disabled={!newName.trim() || selectedSongs.length === 0 || saving}>
            {t('作成')}
          </Button>
        </form>
      ) : (
        <div className="flex min-w-0 flex-1">
          <Button variant="text" icon={<AddIcon />} className="-ml-3" onClick={() => setCreating(true)}>
            {t('新しいプレイリストを作成')}
          </Button>
        </div>
      )}
    >
      {fromQueue && (
        <div className="mb-3 flex flex-wrap gap-2" role="group" aria-label={t('保存する曲')}>
          {QUEUE_SCOPES.map(scope => (
            <Chip key={scope} selected={queueScope === scope} onClick={() => setQueueScope(scope)}>
              {scopeLabel(scope)}
            </Chip>
          ))}
        </div>
      )}
      <ul className="m-0 -mx-3 list-none p-0">
        {rows.map(({ playlist, included }) => {
          const checked = selectedSongs.length > 0 && included === selectedSongs.length;
          const mixed = included > 0 && !checked;
          const disabledReason = playlist.smartRule
            ? t('スマートプレイリストには追加できません')
            : isSyncedPlaylist(playlist) ? t('同期中のプレイリストには追加できません') : null;
          const disabled = disabledReason !== null || selectedSongs.length === 0 || saving;
          const row = (
            <button
              type="button"
              role="checkbox"
              aria-checked={mixed ? 'mixed' : checked}
              aria-disabled={disabled || undefined}
              onClick={disabled ? undefined : () => { void runSave(() => toggle(playlist, checked)); }}
              className={cx(
                'flex min-h-10 w-full items-center gap-4 rounded-chip px-3 text-left text-sm leading-5 transition-colors duration-150 max-sm:min-h-12',
                disabled ? 'cursor-default text-yt-text-disabled' : 'cursor-pointer text-yt-text hover:bg-yt-tonal',
              )}
            >
              <span aria-hidden="true" className="flex shrink-0">
                {checked
                  ? <CheckBoxIcon className={disabled ? undefined : 'text-yt-link'} />
                  : mixed ? <IndeterminateCheckBoxIcon className={disabled ? undefined : 'text-yt-link'} /> : <CheckBoxOutlineIcon />}
              </span>
              <span className="min-w-0 flex-1 truncate">{displayPlaylistName(playlist, t)}</span>
              {disabledReason ? (
                <span aria-hidden="true" className="flex shrink-0 [&>svg]:size-5">{playlist.smartRule ? <TuneIcon /> : <SyncIcon />}</span>
              ) : (
                <span className="shrink-0 text-xs leading-4 text-yt-text-secondary tabular-nums">
                  {formatCount(playlist.songs.length, 'song', language)}
                </span>
              )}
            </button>
          );
          return (
            <li key={playlist.id}>
              {disabledReason ? <Tooltip content={disabledReason} placement="left">{row}</Tooltip> : row}
            </li>
          );
        })}
      </ul>
    </Dialog>
  );
}
