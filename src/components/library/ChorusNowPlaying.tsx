import { useId } from 'react';
import type { Song } from '../../types/vocadb';
import { useTranslateSourceText } from '../../i18n';
import { MOBILE_MEDIA_QUERY, useMediaQuery } from '../../hooks/useMediaQuery';
import { formatArtistLine, formatClockDuration } from '../../utils/songMeta';
import StarRating from '../player/StarRating';
import Button from '../ui/Button';
import IconButton from '../ui/IconButton';
import SongThumbnail from '../ui/SongThumbnail';
import { CheckIcon, PlaylistAddIcon, SkipNextIcon } from '../ui/icons';

export interface ChorusNowPlayingProps {
  song: Song;
  /** 1-based position in the highlight queue. */
  position: number;
  total: number;
  /** Where the chorus starts (seconds into the song). */
  startSeconds: number;
  /** Seconds played inside the chorus window and the window length. */
  elapsed: number;
  windowLength: number;
  /** 「フルで聴く」: the song keeps playing to the end instead of skipping after the chorus. */
  fullSong: boolean;
  /** Song position and length, shown instead of the window while listening to the full song. */
  progress: number;
  duration: number;
  rating: number;
  onRate: (rating: number) => void;
  onSave: () => void;
  onToggleFullSong: () => void;
  onSkip: () => void;
}

/** The song that is playing in the chorus highlights: thumbnail, title, chorus progress and actions. */
export default function ChorusNowPlaying({
  song,
  position,
  total,
  startSeconds,
  elapsed,
  windowLength,
  fullSong,
  progress,
  duration,
  rating,
  onRate,
  onSave,
  onToggleFullSong,
  onSkip,
}: ChorusNowPlayingProps) {
  const t = useTranslateSourceText();
  const titleId = useId();
  const isMobile = useMediaQuery(MOBILE_MEDIA_QUERY);
  const current = fullSong ? progress : elapsed;
  const length = Math.max(1, fullSong ? duration || song.lengthSeconds || 1 : windowLength);
  const clamped = Math.min(length, Math.max(0, current));
  const progressText = `${formatClockDuration(clamped)} / ${formatClockDuration(length)}`;

  return (
    <section aria-labelledby={titleId} className="overflow-hidden rounded-panel bg-yt-tonal-solid md:flex">
      {/* Phones: the mini player right below already shows this video, and without a second copy of it
          the rating and the buttons stay above the mini player. */}
      {!isMobile && (
        <SongThumbnail
          song={song}
          className="w-full md:w-[320px] md:shrink-0 lg:w-[360px]"
          radius="none"
          showDuration={false}
          loading="eager"
        />
      )}
      <div className="min-w-0 flex-1 p-4 sm:p-6">
        <p className="m-0 text-xs leading-4 text-yt-text-secondary tabular-nums">
          {t('{current} / {total} · サビ {time}〜', {
            current: position,
            total,
            time: formatClockDuration(startSeconds),
          })}
        </p>
        <h2 id={titleId} className="m-0 mt-1 line-clamp-2 break-words text-base leading-[22px] font-bold text-yt-text sm:text-xl sm:leading-7">
          {song.name}
        </h2>
        <p className="m-0 mt-1 truncate text-sm leading-5 text-yt-text-secondary">
          {formatArtistLine(song, { withVocalists: true })}
        </p>
        {song.isSelfCover && (
          <span className="mt-2 inline-flex h-6 items-center rounded-chip bg-yt-tonal px-2 text-xs leading-4 text-yt-text">
            {t('セルフカバー')}
          </span>
        )}

        <div className="mt-4">
          <div
            role="progressbar"
            aria-labelledby={titleId}
            aria-valuemin={0}
            aria-valuemax={Math.round(length)}
            aria-valuenow={Math.round(clamped)}
            aria-valuetext={progressText}
            className="h-1 overflow-hidden rounded-full bg-yt-tonal-solid-hover"
          >
            <div className="h-full rounded-full bg-brand" style={{ width: `${(clamped / length) * 100}%` }} />
          </div>
          <div className="mt-1 text-right text-xs leading-4 text-yt-text-secondary tabular-nums">{progressText}</div>
        </div>

        <div className="mt-3 flex items-center">
          <StarRating rating={rating} onRate={onRate} />
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {isMobile ? (
            <IconButton label={t('保存')} icon={<PlaylistAddIcon />} variant="tonal" onClick={onSave} />
          ) : (
            <Button icon={<PlaylistAddIcon />} onClick={onSave}>{t('保存')}</Button>
          )}
          <Button
            aria-pressed={fullSong}
            icon={fullSong ? <CheckIcon /> : undefined}
            onClick={onToggleFullSong}
          >
            {t('フルで聴く')}
          </Button>
          <Button variant="primary" icon={<SkipNextIcon />} onClick={onSkip} className="ml-auto">
            {t('スキップ')}
          </Button>
        </div>
      </div>
    </section>
  );
}
