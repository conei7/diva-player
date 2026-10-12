import type { SoundMapPoint } from '../../api/soundMap';
import type { Song } from '../../types/vocadb';
import { useTranslateSourceText } from '../../i18n';
import { usePlayerStore } from '../../stores/playerStore';
import { soundMapSimilarityPercent } from '../../utils/soundMap';
import { formatArtistLine } from '../../utils/songMeta';
import Button from '../ui/Button';
import IconButton from '../ui/IconButton';
import SongActionsMenu from '../ui/SongActionsMenu';
import SongListRow from '../ui/SongListRow';
import { ChevronDownIcon, ChevronUpIcon, PlayIcon } from '../ui/icons';
import { hasPlayableVideo, placeholderSong } from './discoverySongs';


export interface SoundMapNearbyProps {
  points: SoundMapPoint[];
  selectedId: number | null;
  songsById: ReadonlyMap<number, Song>;
  /** Local demo / pilot: no ⋮ and no 「すべて再生」 (there is no backend). */
  actionsDisabled: boolean;
  /** Rows shown before 「もっと見る」. */
  initialCount: number;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  onSelect: (point: SoundMapPoint) => void;
}

/** 「近くの曲」: the map's songs as rows (also the way to reach them without the map). */
export default function SoundMapNearby({
  points,
  selectedId,
  songsById,
  actionsDisabled,
  initialCount,
  expanded,
  onExpandedChange,
  onSelect,
}: SoundMapNearbyProps) {
  const t = useTranslateSourceText();
  if (points.length === 0) return null;
  const visible = expanded ? points : points.slice(0, initialCount);
  const playable = actionsDisabled
    ? []
    : visible
      .map(point => songsById.get(point.songId))
      .filter((song): song is Song => song !== undefined && hasPlayableVideo(song));

  return (
    <section aria-labelledby="sound-map-nearby-heading" className="-mx-2 min-w-0">
      <div className="mb-1 flex min-h-10 items-center justify-between gap-3 px-2">
        <h2 id="sound-map-nearby-heading" className="m-0 text-base font-bold leading-[22px] text-yt-text">{t('近くの曲')}</h2>
        {playable.length > 0 && (
          <Button
            size="sm"
            icon={<PlayIcon />}
            onClick={() => usePlayerStore.getState().setQueue(playable, 0, true, 'discovery', t('近くの曲'))}
          >
            {t('すべて再生')}
          </Button>
        )}
      </div>
      <ul className="m-0 list-none p-0">
        {visible.map(point => {
          const full = actionsDisabled ? undefined : songsById.get(point.songId);
          const song = full ?? placeholderSong(point);
          const percent = soundMapSimilarityPercent(point.similarity);
          const artist = formatArtistLine(song) || t('アーティスト不明');
          // Thumbnail hover ▶ (§6.7.2): plays just this song; selecting the row still never plays.
          const playOverlay = full && hasPlayableVideo(full) ? (
            <IconButton
              variant="overlay"
              label={t('「{title}」を再生', { title: full.name })}
              icon={<PlayIcon />}
              onClick={() => usePlayerStore.getState().playSong(full, true)}
            />
          ) : undefined;
          return (
            <li key={point.songId}>
              <SongListRow
                song={song}
                size="md"
                className={point.songId === selectedId ? 'bg-yt-tonal' : undefined}
                onActivate={() => onSelect(point)}
                meta={[percent === null ? artist : `${artist} · ${t('類似度 {percent}%', { percent })}`]}
                thumbnailOverlay={playOverlay}
                trailing={full ? <SongActionsMenu song={full} /> : undefined}
              />
            </li>
          );
        })}
      </ul>
      {points.length > initialCount && (
        <div className="px-2 pt-1">
          <Button
            variant="text"
            size="sm"
            trailingIcon={expanded ? <ChevronUpIcon /> : <ChevronDownIcon />}
            aria-expanded={expanded}
            onClick={() => onExpandedChange(!expanded)}
          >
            {expanded ? t('一部を表示') : t('もっと見る')}
          </Button>
        </div>
      )}
    </section>
  );
}
