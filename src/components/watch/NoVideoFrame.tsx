import type { Song } from '../../types/vocadb';
import { usePlayerStore } from '../../stores/playerStore';
import { useTranslateSourceText } from '../../i18n';
import Button, { buttonClassName } from '../ui/Button';
import { OpenInNewIcon, SkipNextIcon } from '../ui/icons';
import { cx } from '../ui/overlay';
import { VIDEO_FRAME_CLASS } from './videoFrame';

/**
 * Shown in place of the video for a song without a playable video. The queue and the playing
 * song are left alone. No player rectangle is registered; the box sits above the persistent
 * player (z-index 11 > 10) in case it still holds the previous, paused video at this spot.
 */
export default function NoVideoFrame({ song }: { song: Song }) {
  const t = useTranslateSourceText();
  const hasNext = usePlayerStore(state => state.queueIndex >= 0 && state.queueIndex < state.queue.length - 1);
  const next = usePlayerStore(state => state.next);

  return (
    <div
      data-testid="watch-no-video"
      className={cx(
        VIDEO_FRAME_CLASS,
        'relative z-[11] flex flex-col items-center justify-center gap-4 border border-yt-divider bg-yt-bg px-6 text-center max-sm:border-x-0',
      )}
    >
      <p className="m-0 text-base font-medium leading-6 text-yt-text">{t('この曲には再生できる動画がありません')}</p>
      <div className="flex flex-wrap items-center justify-center gap-2">
        <a
          href={`https://vocadb.net/S/${song.id}`}
          target="_blank"
          rel="noopener noreferrer"
          className={cx(buttonClassName({ variant: 'tonal' }), 'gap-1.5 pl-3 [&>svg]:size-5')}
        >
          <OpenInNewIcon size={20} />
          {t('VocaDBで開く')}
        </a>
        {hasNext && (
          <Button variant="primary" icon={<SkipNextIcon />} onClick={next}>
            {t('次の曲へ')}
          </Button>
        )}
      </div>
    </div>
  );
}
