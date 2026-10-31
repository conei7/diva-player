import { useCallback, useRef } from 'react';
import type { MouseEvent } from 'react';
import { useTranslateSourceText } from '../../i18n';
import { useMusicLayoutStore } from '../../stores/musicLayoutStore';
import { usePlayerStore } from '../../stores/playerStore';
import { useAutoQueueStatusStore } from '../../stores/autoQueueStatusStore';
import { displayQueueTitle } from '../../utils/displayNames';
import IconButton from '../ui/IconButton';
import { CloseIcon } from '../ui/icons';
import { captureRemovalFocusFallback, focusElement } from '../ui/overlay';
import { QueueHeader, QueueList } from '../watch/PlaylistPanel';
import { useQueueView } from '../watch/useQueueView';
import NowPlayingSongInfo from './nowPlaying/NowPlayingSongInfo';
import NowPlayingVideoSlot from './nowPlaying/NowPlayingVideoSlot';

/** 次に再生: the queue (the same header and rows as the queue drawer). The panel scrolls, not the list. */
function UpNext() {
  const t = useTranslateSourceText();
  const { queue, view } = useQueueView();
  const loopMode = usePlayerStore(state => state.loopMode);
  const autoQueueStatus = useAutoQueueStatusStore(state => state.status);

  if (queue.length === 0) return null;
  // The list says so itself while autoplay adds songs or has none left.
  const listExplainsEnd = autoQueueStatus === 'fetching' || autoQueueStatus === 'reranking' || autoQueueStatus === 'exhausted';
  const isLastSong = !view.nextSong && loopMode === 'none' && !listExplainsEnd;

  return (
    <section data-testid="music-now-playing-queue" className="mt-6">
      <QueueHeader view={view} title={t('次に再生')} className="px-0! pt-0!" />
      <QueueList view={view} scroll={false} className="-mx-1 pb-0!" />
      {isLastSong && (
        <p className="m-0 px-1 pt-1 text-xs leading-4 text-yt-text-secondary">{t('最後の曲です')}</p>
      )}
    </section>
  );
}

/**
 * The music layout's right 「再生中」 panel (MusicDock shows it from 1024px while a song is loaded,
 * off the song page, until it is closed here or from the player bar).
 *
 * - Head (exactly --music-panel-head, 48px): the queue's name and 閉じる. Its tooltip opens to the
 *   left so it never lands on the video below.
 * - The video slot, right under the head with 12px on each side: GlobalPlayer lays the video over
 *   exactly this box with CSS (.music-docked-player), so nothing here may move it or sit on it.
 * - Below, the only part that scrolls: the song (title, producers, rating, actions) and 次に再生.
 */
export default function MusicNowPlayingPanel() {
  const t = useTranslateSourceText();
  const song = usePlayerStore(state => state.currentSong);
  const queueTitle = usePlayerStore(state => state.queueTitle);
  const setNowPlayingOpen = useMusicLayoutStore(state => state.setNowPlayingOpen);
  const titleRef = useRef<HTMLAnchorElement>(null);

  const close = useCallback((event: MouseEvent<HTMLButtonElement>) => {
    // The panel goes away with the button: keep the keyboard on the page — on the player bar's
    // 再生中 toggle that opens it again, else the next control after the panel.
    const keepFocus = captureRemovalFocusFallback(event.currentTarget);
    setNowPlayingOpen(false);
    requestAnimationFrame(() => {
      const active = document.activeElement;
      if (active && active !== document.body && active !== document.documentElement) return;
      const toggle = document.querySelector('[data-testid="music-now-playing-toggle"]:not(:disabled)');
      if (toggle instanceof HTMLElement) focusElement(toggle);
      else keepFocus();
    });
  }, [setNowPlayingOpen]);
  const focusTitle = useCallback(() => focusElement(titleRef.current), []);

  if (!song) return null;
  const title = displayQueueTitle(queueTitle, t) || t('再生中');

  return (
    <aside className="music-side-panel music-now-playing" aria-label={t('再生中')} data-testid="music-now-playing">
      <div className="flex h-[var(--music-panel-head,48px)] flex-none items-center gap-2 pl-3 pr-1">
        <h2 className="m-0 min-w-0 flex-1 truncate text-base font-bold leading-6 text-yt-text">{title}</h2>
        <IconButton
          label={t('再生中の表示を閉じる')}
          icon={<CloseIcon />}
          tooltipPlacement="left"
          data-testid="music-now-playing-close"
          onClick={close}
        />
      </div>

      <div className="flex-none px-3">
        <NowPlayingVideoSlot song={song} onButtonGone={focusTitle} />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-3">
        <NowPlayingSongInfo song={song} titleRef={titleRef} />
        <UpNext />
      </div>
    </aside>
  );
}
