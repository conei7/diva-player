import { Fragment } from 'react';
import type { Ref } from 'react';
import { Link } from 'react-router';
import type { Song } from '../../../types/vocadb';
import { useTranslateSourceText } from '../../../i18n';
import { useRatingStore } from '../../../stores/ratingStore';
import { useUiStore } from '../../../stores/uiStore';
import { usePlaylistStore, WATCH_LATER_ID } from '../../../stores/playlistStore';
import { artistPath, searchPath, watchPath } from '../../../utils/routes';
import { getSongProducerLinks } from '../../search/songCardMeta';
import StarRating from '../../player/StarRating';
import PVSourceSelector from '../../player/PVSourceSelector';
import Button from '../../ui/Button';
import Tooltip from '../../ui/Tooltip';
import { CheckIcon, ClockIcon, InfoIcon, PlaylistAddIcon, ShareIcon } from '../../ui/icons';
import { shareSong, toggleWatchLater } from '../../watch/watchActions';

/** 36px like the song page's pills; 40px where the pointer is a finger. */
const PILL = 'pointer-coarse:h-10';

const PRODUCER_LINK = 'text-inherit no-underline transition-colors duration-150 hover:text-yt-text hover:underline focus-visible:text-yt-text';

/** Producers as links to their song lists (by name when VocaDB has no id), else the credit line. */
function ProducerLinks({ song }: { song: Song }) {
  const producers = getSongProducerLinks(song);
  if (producers.length === 0) return <>{song.artistString}</>;
  return (
    <>
      {producers.map((producer, index) => (
        <Fragment key={`${producer.id ?? 'name'}-${producer.name}`}>
          {index > 0 && ', '}
          <Link
            to={producer.id ? artistPath({ id: producer.id, name: producer.name }) : searchPath(producer.name, 'producer')}
            className={PRODUCER_LINK}
          >
            {producer.name}
          </Link>
        </Fragment>
      ))}
    </>
  );
}

interface NowPlayingSongInfoProps {
  song: Song;
  titleRef?: Ref<HTMLAnchorElement>;
}

/**
 * Under the video: the title (opens the song page), the producers, the rating and the song's actions
 * as tonal pills (保存 · 後で聴く · 共有 · video source · 曲の詳細). They wrap in the narrow panel.
 * Every popup here (the tooltip of 保存) opens below its button, away from the video above.
 * The pills are 40px tall on touch screens (tablets in landscape get this panel too).
 */
export default function NowPlayingSongInfo({ song, titleRef }: NowPlayingSongInfoProps) {
  const t = useTranslateSourceText();
  const rating = useRatingStore(state => state.ratings[String(song.id)] ?? 0);
  const setRating = useRatingStore(state => state.setRating);
  const openSaveToPlaylist = useUiStore(state => state.openSaveToPlaylist);
  const openSongDetail = useUiStore(state => state.openSongDetail);
  const inWatchLater = usePlaylistStore(state => state.playlists
    .find(playlist => playlist.id === WATCH_LATER_ID)?.songs.some(item => item.id === song.id) ?? false);

  return (
    <div data-testid="music-now-playing-song" className="pt-3">
      <h2 className="m-0 line-clamp-2 break-words text-xl font-bold leading-7 text-yt-text">
        <Link
          ref={titleRef}
          to={watchPath(song.id, { autoplay: false })}
          className="rounded-chip text-inherit no-underline outline-none hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-yt-focus"
        >
          {song.name}
        </Link>
      </h2>
      <p className="m-0 mt-0.5 line-clamp-2 break-words text-sm leading-5 text-yt-text-secondary">
        <ProducerLinks song={song} />
      </p>

      <div className="-ml-0.5 mt-2 flex h-9 items-center">
        <StarRating rating={rating} onRate={value => setRating(song.id, value)} size="md" />
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Tooltip content={t('プレイリストに保存')}>
          <Button
            icon={<PlaylistAddIcon />}
            aria-label={t('プレイリストに保存')}
            className={PILL}
            onClick={() => openSaveToPlaylist(song)}
          >
            {t('保存')}
          </Button>
        </Tooltip>
        <Button
          icon={inWatchLater ? <CheckIcon /> : <ClockIcon />}
          aria-pressed={inWatchLater}
          className={PILL}
          onClick={() => void toggleWatchLater(song, t)}
        >
          {t('後で聴く')}
        </Button>
        <Button icon={<ShareIcon />} className={PILL} onClick={() => shareSong(song, t)}>
          {t('共有')}
        </Button>
        <PVSourceSelector song={song} compact />
        <Button icon={<InfoIcon />} className={PILL} onClick={() => openSongDetail(song)}>
          {t('曲の詳細')}
        </Button>
      </div>
    </div>
  );
}
