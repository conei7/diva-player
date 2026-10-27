import { useAsyncAction } from '../../hooks/useAsyncAction';
import { useId, useRef, useState } from 'react';
import type { Playlist, PlaylistFolder } from '../../types/vocadb';
import { useTranslateSourceText } from '../../i18n';
import Button from '../ui/Button';
import Dialog from '../ui/Dialog';
import { ChevronDownIcon } from '../ui/icons';
import PlaylistThumbnail from './PlaylistThumbnail';
import { PLAYLIST_FIELD_CLASS, PLAYLIST_FIELD_LABEL_CLASS } from './playlistDisplay';

export interface PlaylistEditValues {
  name: string;
  description?: string;
  coverArtUrl?: string;
  folderId?: string;
}

interface PlaylistEditDialogProps {
  playlist: Playlist;
  folders: PlaylistFolder[];
  /** 「フォルダーに移動」 opens the dialog with the folder field focused. */
  focus?: 'folder';
  onClose: () => void;
  onSave: (values: PlaylistEditValues) => void | Promise<void>;
}

/** プレイリストを編集: title, description, folder, and the image URL under 詳細. */
export default function PlaylistEditDialog({ playlist, folders, focus, onClose, onSave }: PlaylistEditDialogProps) {
  const { busy: saving, run: runSave } = useAsyncAction();
  const t = useTranslateSourceText();
  const formId = useId();
  const folderRef = useRef<HTMLSelectElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(playlist.name);
  const [description, setDescription] = useState(playlist.description ?? '');
  const [coverArtUrl, setCoverArtUrl] = useState(playlist.coverArtUrl ?? '');
  const [folderId, setFolderId] = useState(playlist.folderId && folders.some(folder => folder.id === playlist.folderId) ? playlist.folderId : '');
  const preview = { ...playlist, coverArtUrl: coverArtUrl.trim() || undefined };

  const submit = () => {
    void runSave(() => onSave({
      name: name.trim() || playlist.name,
      description: description.trim() || undefined,
      coverArtUrl: coverArtUrl.trim() || undefined,
      folderId: folderId || undefined,
    }));
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={t('プレイリストを編集')}
      size="md"
      initialFocusRef={focus === 'folder' && folders.length > 0 ? folderRef : titleRef}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose}>{t('キャンセル')}</Button>
          <Button type="submit" form={formId} variant="primary" loading={saving} disabled={saving}>{t('保存')}</Button>
        </>
      )}
    >
      <form
        id={formId}
        className="flex flex-col gap-4 pt-1"
        onSubmit={event => {
          event.preventDefault();
          submit();
        }}
      >
        <PlaylistThumbnail playlist={preview} stacked={false} showCount={false} className="w-40" />
        <label className="block">
          <span className={PLAYLIST_FIELD_LABEL_CLASS}>{t('タイトル')}</span>
          <input
            ref={titleRef}
            className={PLAYLIST_FIELD_CLASS}
            value={name}
            onChange={event => setName(event.target.value)}
            placeholder={t('タイトルを入力')}
            maxLength={150}
          />
        </label>
        <label className="block">
          <span className={PLAYLIST_FIELD_LABEL_CLASS}>{t('説明')}</span>
          <textarea
            className={`${PLAYLIST_FIELD_CLASS} min-h-24 resize-y`}
            value={description}
            onChange={event => setDescription(event.target.value)}
            placeholder={t('説明を追加')}
            maxLength={2000}
            rows={3}
          />
        </label>
        {folders.length > 0 && (
          <label className="block">
            <span className={PLAYLIST_FIELD_LABEL_CLASS}>{t('フォルダー')}</span>
            <select ref={folderRef} className={PLAYLIST_FIELD_CLASS} value={folderId} onChange={event => setFolderId(event.target.value)}>
              <option value="">{t('なし')}</option>
              {folders.map(folder => <option key={folder.id} value={folder.id}>{folder.name}</option>)}
            </select>
          </label>
        )}
        <details className="group/details" open={Boolean(playlist.coverArtUrl) && !playlist.songs.some(song => song.thumbUrl === playlist.coverArtUrl) ? true : undefined}>
          <summary className="flex min-h-10 cursor-pointer list-none items-center gap-1 text-sm font-medium text-yt-text [&::-webkit-details-marker]:hidden">
            <ChevronDownIcon size={20} className="-rotate-90 transition-transform duration-150 group-open/details:rotate-0" />
            {t('詳細')}
          </summary>
          <label className="mt-2 block">
            <span className={PLAYLIST_FIELD_LABEL_CLASS}>{t('画像のURL')}</span>
            <input
              className={PLAYLIST_FIELD_CLASS}
              type="text"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              value={coverArtUrl}
              onChange={event => setCoverArtUrl(event.target.value)}
              placeholder="https://"
            />
          </label>
        </details>
      </form>
    </Dialog>
  );
}
