import { useMemo, useState } from 'react';
import type { Song } from '../../types/vocadb';
import { useTranslateSourceText } from '../../i18n';
import { usePlayerStore } from '../../stores/playerStore';
import { getWideSongThumbnailCandidates } from '../../utils/songThumbnail';
import Button from '../ui/Button';
import Menu, { MenuItem } from '../ui/Menu';
import { ChevronDownIcon, MusicNoteIcon, PlayIcon, VolumeBarsIcon } from '../ui/icons';
import { UndoIcon } from './discoveryIcons';

function OriginThumb({ song, playing }: { song: Song; playing: boolean }) {
  const hiddenMode = usePlayerStore(state => state.hiddenMode);
  const candidates = useMemo(() => getWideSongThumbnailCandidates(song), [song]);
  const [failed, setFailed] = useState<readonly string[]>([]);
  const url = hiddenMode ? undefined : candidates.find(candidate => !failed.includes(candidate));
  if (playing) return <VolumeBarsIcon className="text-brand" />;
  if (!url) return <MusicNoteIcon />;
  return <img src={url} alt="" className="size-6 rounded-full object-cover" onError={() => setFailed(previous => [...previous, url])} />;
}

export interface SoundMapOriginMenuProps {
  /** The starting song (full when loaded, otherwise a placeholder with its title). */
  song: Song;
  playing: boolean;
  /** The song in the player, when it isn't already the starting song. */
  playingSongId: number | null;
  canGoBack: boolean;
  onUsePlaying: () => void;
  onBack: () => void;
}

/** 「起点: {曲名}」 pill: shows where the map starts and switches it. */
export default function SoundMapOriginMenu({ song, playing, playingSongId, canGoBack, onUsePlaying, onBack }: SoundMapOriginMenuProps) {
  const t = useTranslateSourceText();
  return (
    <Menu
      trigger={(
        <Button
          icon={<OriginThumb song={song} playing={playing} />}
          trailingIcon={<ChevronDownIcon />}
          className="max-w-full sm:max-w-80"
        >
          {t('起点: {song}', { song: song.name })}
        </Button>
      )}
      align="end"
      label={t('起点')}
    >
      <MenuItem icon={<PlayIcon />} disabled={playingSongId === null} onSelect={onUsePlaying}>
        {t('再生中の曲を起点にする')}
      </MenuItem>
      <MenuItem icon={<UndoIcon />} disabled={!canGoBack} onSelect={onBack}>
        {t('前の起点に戻る')}
      </MenuItem>
    </Menu>
  );
}
