import { useRef } from 'react';
import { useDialogFocus } from '../../hooks/useDialogFocus';
import { usePlayerStore } from '../../stores/playerStore';
import { useTranslateSourceText } from '../../i18n';
import { displayQueueTitle } from '../../utils/displayNames';
import IconButton from '../ui/IconButton';
import EmptyState from '../ui/EmptyState';
import { CloseIcon, QueueMusicIcon } from '../ui/icons';
import { cx } from '../ui/overlay';
import { QueueHeader, QueueList } from '../watch/PlaylistPanel';
import { useQueueView } from '../watch/useQueueView';

/**
 * キュー (opened from the mini player). A right drawer, full width on phones.
 * It stays mounted once opened: while closed it is moved off screen and made inert.
 * The header and rows are the same parts as the watch page's playing-list panel.
 */
export default function QueueDrawer() {
  const t = useTranslateSourceText();
  const queueDrawerOpen = usePlayerStore(state => state.queueDrawerOpen);
  const toggleQueueDrawer = usePlayerStore(state => state.toggleQueueDrawer);
  const { queue, queueTitle, view } = useQueueView();
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogFocus(dialogRef, queueDrawerOpen, toggleQueueDrawer);

  const title = displayQueueTitle(queueTitle, t) || t('キュー');
  const closeButton = <IconButton label={t('閉じる')} icon={<CloseIcon />} onClick={toggleQueueDrawer} />;

  return (
    <>
      {queueDrawerOpen && (
        <div
          className="fixed inset-0 z-[var(--z-drawer,60)] bg-overlay"
          onClick={toggleQueueDrawer}
          aria-hidden="true"
        />
      )}

      <div
        ref={dialogRef}
        inert={!queueDrawerOpen}
        aria-hidden={!queueDrawerOpen}
        aria-modal={queueDrawerOpen || undefined}
        tabIndex={-1}
        role="dialog"
        data-testid="queue-drawer"
        aria-label={t('キュー')}
        className={cx(
          'queue-drawer fixed right-0 top-0 z-[var(--z-drawer,60)] flex h-dvh w-[400px] max-w-full flex-col bg-yt-bg text-yt-text outline-none',
          'transition-transform duration-200 ease-out motion-reduce:transition-none',
          queueDrawerOpen ? 'translate-x-0 shadow-[-8px_0_32px_rgba(0,0,0,0.5)]' : 'translate-x-full',
        )}
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
      >
        {queue.length === 0 ? (
          <>
            <div className="flex shrink-0 items-center gap-2 px-4 pb-1 pt-3">
              <h2 className="min-w-0 flex-1 truncate text-xl font-bold leading-7">{t('キュー')}</h2>
              <div className="-mr-2">{closeButton}</div>
            </div>
            <EmptyState
              icon={<QueueMusicIcon />}
              title={t('キューは空です')}
              action={{ label: t('曲を探す'), to: '/', onClick: toggleQueueDrawer }}
            />
          </>
        ) : (
          <>
            <QueueHeader view={view} title={title} end={closeButton} />
            <QueueList view={view} revealKey={queueDrawerOpen} />
          </>
        )}
      </div>
    </>
  );
}
