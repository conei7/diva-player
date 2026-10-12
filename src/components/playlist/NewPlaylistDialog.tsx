import { useId, useState } from 'react';
import type { PlaylistFolder } from '../../types/vocadb';
import { useTranslateSourceText } from '../../i18n';
import Button from '../ui/Button';
import Dialog from '../ui/Dialog';
import { PLAYLIST_FIELD_CLASS, PLAYLIST_FIELD_LABEL_CLASS } from './playlistDisplay';

interface NewPlaylistDialogProps {
  open: boolean;
  folders: PlaylistFolder[];
  /** Folder chosen in the library's chips, used as the default. */
  defaultFolderId?: string;
  onClose: () => void;
  onCreate: (name: string, folderId?: string) => void;
}

function NewPlaylistForm({ folders, defaultFolderId, onClose, onCreate }: Omit<NewPlaylistDialogProps, 'open'>) {
  const t = useTranslateSourceText();
  const formId = useId();
  const [name, setName] = useState('');
  const [folderId, setFolderId] = useState(defaultFolderId && folders.some(folder => folder.id === defaultFolderId) ? defaultFolderId : '');
  const trimmed = name.trim();

  return (
    <Dialog
      open
      onClose={onClose}
      title={t('新しいプレイリスト')}
      size="sm"
      footer={(
        <>
          <Button variant="ghost" onClick={onClose}>{t('キャンセル')}</Button>
          <Button type="submit" form={formId} variant="primary" disabled={!trimmed} aria-label={t('プレイリストを作成')}>
            {t('作成')}
          </Button>
        </>
      )}
    >
      <form
        id={formId}
        className="flex flex-col gap-4 pt-1"
        onSubmit={event => {
          event.preventDefault();
          if (trimmed) onCreate(trimmed, folderId || undefined);
        }}
      >
        <label className="block">
          <span className={PLAYLIST_FIELD_LABEL_CLASS}>{t('タイトル')}</span>
          <input
            className={PLAYLIST_FIELD_CLASS}
            value={name}
            onChange={event => setName(event.target.value)}
            placeholder={t('タイトルを入力')}
            maxLength={150}
            autoFocus
          />
        </label>
        {folders.length > 0 && (
          <label className="block">
            <span className={PLAYLIST_FIELD_LABEL_CLASS}>{t('フォルダー')}</span>
            <select className={PLAYLIST_FIELD_CLASS} value={folderId} onChange={event => setFolderId(event.target.value)}>
              <option value="">{t('なし')}</option>
              {folders.map(folder => <option key={folder.id} value={folder.id}>{folder.name}</option>)}
            </select>
          </label>
        )}
      </form>
    </Dialog>
  );
}

/** 新しいプレイリスト: a title and an optional folder. */
export default function NewPlaylistDialog({ open, ...props }: NewPlaylistDialogProps) {
  if (!open) return null;
  return <NewPlaylistForm {...props} />;
}
