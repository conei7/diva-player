import type { KnowledgeMapTile } from '../../api/knowledgeMap';
import type { Song } from '../../types/vocadb';
import { useTranslateSourceText } from '../../i18n';
import { useLanguageStore } from '../../stores/languageStore';
import { usePlayerStore, type PlaybackSource } from '../../stores/playerStore';
import { formatArtistLine, formatViewCount } from '../../utils/songMeta';
import Button from '../ui/Button';
import { MenuItem } from '../ui/Menu';
import SongActionsMenu from '../ui/SongActionsMenu';
import SongListRow from '../ui/SongListRow';
import { PlayIcon, ScatterIcon } from '../ui/icons';
import { hasPlayableVideo, placeholderSong } from './discoverySongs';

export interface KnowledgeRankingProps {
  title: string;
  headingId: string;
  tiles: KnowledgeMapTile[];
  empty: string;
  songsById: ReadonlyMap<number, Song>;
  /** How plays started from 「すべて再生」 are counted. */
  playSource: PlaybackSource;
}

/** Top songs of one side (known / not yet known) as numbered rows with ⋮. */
export default function KnowledgeRanking({ title, headingId, tiles, empty, songsById, playSource }: KnowledgeRankingProps) {
  const t = useTranslateSourceText();
  const language = useLanguageStore(state => state.language);
  const playable = tiles
    .map(tile => songsById.get(tile.songId))
    .filter((song): song is Song => song !== undefined && hasPlayableVideo(song));

  return (
    <section data-testid="knowledge-map-ranking" aria-labelledby={headingId} className="-mx-2 min-w-0">
      <div className="mb-1 flex min-h-10 items-center justify-between gap-3 px-2">
        <h2 id={headingId} className="m-0 min-w-0 text-base font-bold leading-[22px] text-yt-text sm:text-xl sm:leading-7">
          {title}
        </h2>
        {playable.length > 0 && (
          <Button
            size="sm"
            icon={<PlayIcon />}
            onClick={() => usePlayerStore.getState().setQueue(playable, 0, true, playSource, title)}
          >
            {t('すべて再生')}
          </Button>
        )}
      </div>
      {tiles.length === 0 ? (
        <p className="m-0 px-2 py-6 text-sm leading-5 text-yt-text-secondary">{empty}</p>
      ) : (
        <ol className="m-0 list-none p-0">
          {tiles.map((tile, index) => {
            const full = songsById.get(tile.songId);
            const song = full ?? placeholderSong(tile);
            return (
              <li key={tile.songId}>
                <SongListRow
                  song={song}
                  size="sm"
                  leading={<span className="w-5 text-center text-sm tabular-nums text-yt-text-secondary">{index + 1}</span>}
                  meta={[[formatArtistLine(song), formatViewCount(tile.views, language)].filter(Boolean).join(' · ')]}
                  trailing={full ? (
                    <SongActionsMenu
                      song={full}
                      extraItems={(
                        <MenuItem icon={<ScatterIcon />} href={`/sound-map?seedSongId=${full.id}`}>
                          {t('曲調マップで開く')}
                        </MenuItem>
                      )}
                    />
                  ) : <span aria-hidden="true" className="block size-10" />}
                />
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
