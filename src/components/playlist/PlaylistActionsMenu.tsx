import { useState } from 'react';
import type { Playlist } from '../../types/vocadb';
import { useTranslateSourceText } from '../../i18n';
import { usePlaylistStore } from '../../stores/playlistStore';
import { displayPlaylistName } from '../../utils/displayNames';
import { canEditPlaylistDetails } from '../../utils/playlistPermissions';
import IconButton from '../ui/IconButton';
import Menu, { MenuDivider, MenuItem } from '../ui/Menu';
import {
  DownloadIcon,
  EditIcon,
  FolderIcon,
  MoreVertIcon,
  PlayIcon,
  QueueMusicIcon,
  ShareIcon,
  ShuffleIcon,
  TrashIcon,
} from '../ui/icons';
import { cx } from '../ui/overlay';

/** What a playlist's ⋮ (library card / row) can do. Implemented by PlaylistPage. */
export interface PlaylistActionHandlers {
  onPlayAll: (playlist: Playlist) => void;
  onShufflePlay: (playlist: Playlist) => void;
  onAddToQueue: (playlist: Playlist) => void;
  onEdit: (playlist: Playlist, focus?: 'folder') => void;
  onShare: (playlist: Playlist) => void;
  onExport: (playlist: Playlist) => void;
  onDelete: (playlist: Playlist) => void;
}

interface PlaylistActionsMenuProps {
  playlist: Playlist;
  actions: PlaylistActionHandlers;
  className?: string;
}

/** ⋮ of a playlist in the library. On mouse devices it shows on hover / focus (.reveal-on-hover). */
export default function PlaylistActionsMenu({ playlist, actions, className }: PlaylistActionsMenuProps) {
  const t = useTranslateSourceText();
  const [open, setOpen] = useState(false);
  const label = t('「{title}」のその他の操作', { title: displayPlaylistName(playlist, t) });
  const hasSongs = playlist.songs.length > 0;
  const editable = canEditPlaylistDetails(playlist);
  // Without folders there is nowhere to move to (folders are made from the library's ⋮).
  const hasFolders = usePlaylistStore(state => state.folders.length > 0);

  return (
    <div className={cx('reveal-on-hover flex shrink-0', className)} data-open={open ? 'true' : undefined}>
      <Menu
        trigger={<IconButton label={label} icon={<MoreVertIcon />} />}
        align="end"
        label={label}
        open={open}
        onOpenChange={setOpen}
      >
        <MenuItem icon={<PlayIcon />} disabled={!hasSongs} onSelect={() => actions.onPlayAll(playlist)}>
          {t('すべて再生')}
        </MenuItem>
        <MenuItem icon={<ShuffleIcon />} disabled={!hasSongs} onSelect={() => actions.onShufflePlay(playlist)}>
          {t('シャッフル再生')}
        </MenuItem>
        <MenuItem icon={<QueueMusicIcon />} disabled={!hasSongs} onSelect={() => actions.onAddToQueue(playlist)}>
          {t('キューに追加')}
        </MenuItem>
        {editable && (
          <>
            <MenuDivider />
            <MenuItem icon={<EditIcon />} onSelect={() => actions.onEdit(playlist)}>{t('編集')}</MenuItem>
            {hasFolders && (
              <MenuItem icon={<FolderIcon />} onSelect={() => actions.onEdit(playlist, 'folder')}>{t('フォルダーに移動')}</MenuItem>
            )}
          </>
        )}
        <MenuDivider />
        <MenuItem icon={<ShareIcon />} onSelect={() => actions.onShare(playlist)}>{t('共有')}</MenuItem>
        <MenuItem icon={<DownloadIcon />} onSelect={() => actions.onExport(playlist)}>{t('JSONでエクスポート')}</MenuItem>
        {editable && (
          <>
            <MenuDivider />
            <MenuItem icon={<TrashIcon />} onSelect={() => actions.onDelete(playlist)}>{t('削除')}</MenuItem>
          </>
        )}
      </Menu>
    </div>
  );
}
