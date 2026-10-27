import { useAsyncAction } from '../../hooks/useAsyncAction';
import { useId, useState } from 'react';
import { useTranslateSourceText } from '../../i18n';
import Button from '../ui/Button';
import Dialog from '../ui/Dialog';
import { PLAYLIST_FIELD_CLASS, PLAYLIST_FIELD_LABEL_CLASS } from './playlistDisplay';

interface PlaylistFolderDialogProps {
  /** 'create': フォルダーを作成. 'rename': 名前を変更 (initialName = current name). */
  mode: 'create' | 'rename';
  initialName?: string;
  onClose: () => void;
  onSubmit: (name: string) => void | Promise<void>;
}

/** Small dialog with one 「フォルダー名」 field. */
export default function PlaylistFolderDialog({ mode, initialName = '', onClose, onSubmit }: PlaylistFolderDialogProps) {
  const { busy: saving, run: runSave } = useAsyncAction();
  const t = useTranslateSourceText();
  const formId = useId();
  const [name, setName] = useState(initialName);
  const trimmed = name.trim();
  const unchanged = mode === 'rename' && trimmed === initialName.trim();

  return (
    <Dialog
      open
      onClose={onClose}
      title={mode === 'create' ? t('フォルダーを作成') : t('名前を変更')}
      size="sm"
      footer={(
        <>
          <Button variant="ghost" onClick={onClose}>{t('キャンセル')}</Button>
          <Button type="submit" form={formId} variant="primary" loading={saving} disabled={!trimmed || unchanged || saving}>
            {mode === 'create' ? t('作成') : t('保存')}
          </Button>
        </>
      )}
    >
      <form
        id={formId}
        className="pt-1"
        onSubmit={event => {
          event.preventDefault();
          if (trimmed && !unchanged) void runSave(() => onSubmit(trimmed));
        }}
      >
        <label className="block">
          <span className={PLAYLIST_FIELD_LABEL_CLASS}>{t('フォルダー名')}</span>
          <input
            className={PLAYLIST_FIELD_CLASS}
            value={name}
            onChange={event => setName(event.target.value)}
            maxLength={100}
            autoFocus
          />
        </label>
      </form>
    </Dialog>
  );
}
