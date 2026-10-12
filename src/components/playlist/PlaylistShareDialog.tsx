import { useRef } from 'react';
import { useTranslateSourceText } from '../../i18n';
import Button from '../ui/Button';
import Dialog from '../ui/Dialog';
import { PLAYLIST_FIELD_CLASS } from './playlistDisplay';

/** Shown only when the share link could not be copied: the link to copy by hand. */
export default function PlaylistShareDialog({ url, onClose }: { url: string; onClose: () => void }) {
  const t = useTranslateSourceText();
  const fieldRef = useRef<HTMLTextAreaElement>(null);

  return (
    <Dialog
      open
      onClose={onClose}
      title={t('共有リンク')}
      size="sm"
      initialFocusRef={fieldRef}
      footer={<Button variant="primary" onClick={onClose}>{t('閉じる')}</Button>}
    >
      <textarea
        ref={fieldRef}
        readOnly
        value={url}
        aria-label={t('共有リンク')}
        rows={4}
        onFocus={event => event.currentTarget.select()}
        className={`${PLAYLIST_FIELD_CLASS} resize-none break-all font-mono text-xs`}
      />
    </Dialog>
  );
}
