/**
 * TrackRow – one song of a playlist in the music layout's track table
 * (# | タイトル | プロデューサー | 公開日 | 再生時間 | ⋮). Same props, actions and ⋮ as PlaylistSongRow:
 * the title link covers the row, a plain click / Enter plays the list from this song (a modified
 * click opens the song page), and in selection mode a click toggles the selection.
 */
import { Fragment, memo } from 'react';
import type { MouseEvent, ReactNode } from 'react';
import { Link } from 'react-router';
import type { Song } from '../../../types/vocadb';
import { useTranslateSourceText } from '../../../i18n';
import { useLanguageStore } from '../../../stores/languageStore';
import { usePlayerStore } from '../../../stores/playerStore';
import { useRatingStore } from '../../../stores/ratingStore';
import { formatSongRelativeDate, getSongPublishedAt } from '../../../utils/relativeDate';
import { watchPath } from '../../../utils/routes';
import { formatArtistLine } from '../../../utils/songMeta';
import { PlaylistSongActionsMenu, type PlaylistRowActions } from '../../playlist/PlaylistSongRow';
import IconButton from '../../ui/IconButton';
import { CheckBoxIcon, CheckBoxOutlineIcon, PauseIcon, PlayIcon, VolumeBarsIcon } from '../../ui/icons';
import { cx } from '../../ui/overlay';
import { joinMetaParts } from '../../ui/songMetaParts';
import SquareArt from '../SquareArt';
import {
  formatTrackDuration,
  getTrackProducerLinks,
  TRACK_COLUMN,
  TRACK_ROW_GRID,
  trackLeadColumnClass,
} from './trackTable';

interface TrackRowProps {
  song: Song;
  /** Position in the saved order. */
  index: number;
  /** Position in the list as shown (search / sort applied). */
  position: number;
  lastIndex: number;
  playlistName: string;
  /** Songs can be reordered and removed (not smart / synced). */
  editable: boolean;
  /** Manual order on screen: 一番上に移動 / 一番下に移動 are offered. */
  reorderable: boolean;
  /** 後で聴く: its ⋮ doesn't offer 「後で聴くに保存」. */
  watchLater: boolean;
  active: boolean;
  selectionMode: boolean;
  selected: boolean;
  /** Drag handle (only when manual order can be changed by dragging). */
  dragHandle?: ReactNode;
  actions: PlaylistRowActions;
}

function isPlainLeftClick(event: MouseEvent<HTMLAnchorElement>): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

/** Hover button of the song that is playing: pauses / resumes it instead of starting it over. */
function NowPlayingToggle() {
  const t = useTranslateSourceText();
  const isPlaying = usePlayerStore(state => state.isPlaying);
  return (
    <IconButton
      size="sm"
      tabIndex={-1}
      label={isPlaying ? t('一時停止') : t('再生')}
      icon={isPlaying ? <PauseIcon /> : <PlayIcon />}
      onClick={() => {
        const player = usePlayerStore.getState();
        if (player.isPlaying) player.pause();
        else player.resume();
      }}
    />
  );
}

function TrackRow({
  song,
  index,
  position,
  lastIndex,
  playlistName,
  editable,
  reorderable,
  watchLater,
  active,
  selectionMode,
  selected,
  dragHandle,
  actions,
}: TrackRowProps) {
  const t = useTranslateSourceText();
  const language = useLanguageStore(state => state.language);
  const rating = useRatingStore(state => state.ratings[String(song.id)] ?? 0);

  const artistLine = joinMetaParts([formatArtistLine(song, { withVocalists: true }), rating > 0 ? `★${rating}` : null]);
  const producers = getTrackProducerLinks(song);
  const dateText = formatSongRelativeDate(song, Date.now(), language);
  const duration = formatTrackDuration(song);
  const lead = selectionMode ? 'select' : dragHandle ? 'handle' : 'number';

  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (selectionMode) {
      event.preventDefault();
      actions.toggleSelect(index);
      return;
    }
    if (isPlainLeftClick(event)) {
      event.preventDefault();
      actions.play(position);
    }
  };
  const handleAuxClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (selectionMode) event.preventDefault();
  };

  return (
    <div
      role="row"
      aria-rowindex={position + 2}
      data-testid="music-track-row"
      data-now-playing={active ? 'true' : undefined}
      data-selected={selectionMode && selected ? 'true' : undefined}
      className={cx(
        'group group/track relative h-14 rounded-[4px] transition-colors duration-150',
        TRACK_ROW_GRID,
        selectionMode && selected ? 'bg-yt-tonal' : 'hover:bg-yt-tonal',
        selectionMode && 'select-none',
      )}
    >
      {/* Above the row link; only its buttons take clicks (the number lets clicks through to the row). */}
      <div role="cell" className={cx(trackLeadColumnClass(lead), 'pointer-events-none relative z-[1] [&>button]:pointer-events-auto')}>
        {selectionMode ? (
          <button
            type="button"
            role="checkbox"
            aria-checked={selected}
            aria-label={t('「{title}」を選択', { title: song.name })}
            onClick={() => actions.toggleSelect(index)}
            className="flex h-10 w-10 cursor-pointer items-center justify-center rounded-full text-yt-text transition-colors duration-150 hover:bg-yt-tonal"
          >
            {selected ? <CheckBoxIcon className="text-yt-link" /> : <CheckBoxOutlineIcon />}
          </button>
        ) : (
          <>
            {dragHandle}
            <span className={cx(TRACK_COLUMN.number, 'relative h-10 text-sm leading-5 text-yt-text-secondary tabular-nums')}>
              <span className="flex items-center justify-center transition-opacity duration-150 group-hover/track:opacity-0 group-has-[:focus-visible]/track:opacity-0">
                {active ? <VolumeBarsIcon size={16} className="text-brand" /> : position + 1}
              </span>
              {/* Mouse: ▶ on row hover (keyboard users play with Enter on the title). */}
              <span className="absolute inset-0 flex items-center justify-center opacity-0 transition-opacity duration-150 group-hover/track:opacity-100 group-hover/track:*:pointer-events-auto group-has-[:focus-visible]/track:opacity-100 group-has-[:focus-visible]/track:*:pointer-events-auto">
                {active ? (
                  <NowPlayingToggle />
                ) : (
                  <IconButton
                    size="sm"
                    tabIndex={-1}
                    label={t('「{title}」を再生', { title: song.name })}
                    icon={<PlayIcon />}
                    onClick={() => actions.play(position)}
                  />
                )}
              </span>
            </span>
          </>
        )}
      </div>

      <div role="cell" className={TRACK_COLUMN.title}>
        <SquareArt song={song} className="size-10 max-sm:size-12" radius="sm">
          {/* No # column (phones, or a narrow table): the artwork shows which song is playing. */}
          {active && (
            <span aria-hidden="true" className="absolute inset-0 hidden items-center justify-center bg-black/50 text-white max-sm:flex @max-[25rem]:flex">
              <VolumeBarsIcon size={20} />
            </span>
          )}
        </SquareArt>
        <div className="min-w-0 flex-1">
          <div className={cx('truncate text-base leading-[22px]', active ? 'text-brand' : 'text-yt-text')}>
            <Link
              to={watchPath(song.id, { autoplay: false })}
              onClick={handleClick}
              onAuxClick={handleAuxClick}
              aria-current={active ? 'true' : undefined}
              draggable={false}
              className="text-inherit no-underline after:absolute after:inset-0 after:rounded-[4px] after:content-[''] focus-visible:outline-none focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-yt-focus"
            >
              {song.name}
            </Link>
          </div>
          {artistLine && <div className="truncate text-sm leading-5 text-yt-text-secondary">{artistLine}</div>}
        </div>
      </div>

      <div role="cell" className={cx(TRACK_COLUMN.producer, 'truncate text-sm leading-5 text-yt-text-secondary')}>
        {producers.length > 0 ? producers.map((producer, producerIndex) => (
          <Fragment key={`${producer.name}:${producerIndex}`}>
            {producerIndex > 0 && ', '}
            <Link to={producer.href} className="relative z-[1] text-inherit no-underline hover:text-yt-text hover:underline">
              {producer.name}
            </Link>
          </Fragment>
        )) : '—'}
      </div>

      <div role="cell" className={cx(TRACK_COLUMN.date, 'truncate text-sm leading-5 text-yt-text-secondary')}>
        {dateText ? <time dateTime={getSongPublishedAt(song)}>{dateText}</time> : '—'}
      </div>

      <div role="cell" className={cx(TRACK_COLUMN.duration, 'text-sm leading-5 text-yt-text-secondary tabular-nums')}>
        {duration ?? '—'}
      </div>

      {/* 44px ⋮ on phones (the only control there besides the row). */}
      <div role="cell" className={cx(TRACK_COLUMN.actions, 'relative z-[1] max-sm:[&_button]:size-11')}>
        <PlaylistSongActionsMenu
          song={song}
          index={index}
          lastIndex={lastIndex}
          playlistName={playlistName}
          editable={editable}
          reorderable={reorderable}
          watchLater={watchLater}
          rating={rating}
          actions={actions}
        />
      </div>
    </div>
  );
}

export default memo(TrackRow);
