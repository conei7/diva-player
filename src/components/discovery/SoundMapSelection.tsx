import type { CSSProperties } from 'react';
import type { SoundMapPoint } from '../../api/soundMap';
import type { Song } from '../../types/vocadb';
import { useTranslateSourceText } from '../../i18n';
import { useRootLayoutVariable } from '../../hooks/useRootLayoutVariable';
import { soundMapSimilarityPercent } from '../../utils/soundMap';
import { formatArtistLine } from '../../utils/songMeta';
import Button from '../ui/Button';
import IconButton from '../ui/IconButton';
import Menu, { MenuItem } from '../ui/Menu';
import SongThumbnail from '../ui/SongThumbnail';
import {
  InfoIcon,
  MoreVertIcon,
  OpenPlayerIcon,
  PlayIcon,
  PlaylistAddIcon,
  QueueMusicIcon,
  VolumeBarsIcon,
} from '../ui/icons';
import DemoDisabledTip from './DemoDisabledTip';
import { ExploreNearbyIcon } from './discoveryIcons';

export interface SoundMapSelectionProps {
  point: SoundMapPoint;
  /** The full song when loaded, otherwise a placeholder (title / thumbnail only). */
  song: Song;
  isOrigin: boolean;
  playing: boolean;
  known: boolean;
  /** The local demo / pilot map has no backend: play, save and the ⋮ actions are off. */
  actionsDisabled: boolean;
  onPlay: () => void;
  onExplore: () => void;
  onSave: () => void;
  onDetails: () => void;
  onOpenWatch: () => void;
  onQueue: () => void;
}

function useSelectionText(point: SoundMapPoint, song: Song) {
  const t = useTranslateSourceText();
  const percent = soundMapSimilarityPercent(point.similarity);
  const artist = formatArtistLine(song) || t('アーティスト不明');
  return percent === null ? artist : `${artist} · ${t('類似度 {percent}%', { percent })}`;
}

function SelectionMenu({
  actionsDisabled,
  onDetails,
  onOpenWatch,
  onQueue,
  onSave,
  includeSave,
}: Pick<SoundMapSelectionProps, 'actionsDisabled' | 'onDetails' | 'onOpenWatch' | 'onQueue' | 'onSave'> & { includeSave: boolean }) {
  const t = useTranslateSourceText();
  return (
    <DemoDisabledTip disabled={actionsDisabled}>
      <Menu
        trigger={<IconButton label={t('その他の操作')} icon={<MoreVertIcon />} disabled={actionsDisabled} />}
        align="end"
        label={t('その他の操作')}
      >
        {includeSave && <MenuItem icon={<PlaylistAddIcon />} onSelect={onSave}>{t('保存')}</MenuItem>}
        <MenuItem icon={<InfoIcon />} onSelect={onDetails}>{t('曲の詳細')}</MenuItem>
        <MenuItem icon={<OpenPlayerIcon />} onSelect={onOpenWatch}>{t('再生ページを開く')}</MenuItem>
        <MenuItem icon={<QueueMusicIcon />} onSelect={onQueue}>{t('キューに追加')}</MenuItem>
      </Menu>
    </DemoDisabledTip>
  );
}

/** Right-rail card for the selected dot: 16:9 thumbnail, title, meta and one row of actions. */
export default function SoundMapSelectionCard(props: SoundMapSelectionProps) {
  const { point, song, isOrigin, playing, known, actionsDisabled, onPlay, onExplore, onSave } = props;
  const t = useTranslateSourceText();
  const meta = useSelectionText(point, song);

  return (
    <section aria-labelledby="sound-map-selected-title" className="rounded-card bg-yt-raised p-4">
      <SongThumbnail song={song} className="w-full" radius="sm" nowPlaying={playing} />
      <div className="mt-3 flex items-start gap-2">
        <h2
          id="sound-map-selected-title"
          data-testid="sound-map-selected-title"
          className="m-0 min-w-0 flex-1 line-clamp-2 break-words text-lg font-bold leading-[26px] text-yt-text"
        >
          {point.name}
        </h2>
        <div className="-mr-2 -mt-2 shrink-0">
          <SelectionMenu {...props} includeSave={false} />
        </div>
      </div>
      <p className="m-0 mt-1 truncate text-sm leading-5 text-yt-text-secondary">{meta}</p>
      {(playing || known) && (
        <div className="mt-2 flex flex-wrap gap-2 text-xs font-medium leading-4">
          {playing && (
            <span className="inline-flex items-center gap-1 rounded-badge bg-yt-tonal px-1.5 py-1 text-yt-text">
              <VolumeBarsIcon size={14} className="text-brand" />
              {t('再生中')}
            </span>
          )}
          {known && <span className="rounded-badge bg-yt-tonal px-1.5 py-1 text-yt-text">{t('知っている')}</span>}
        </div>
      )}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <DemoDisabledTip disabled={actionsDisabled}>
          <Button variant="primary" icon={<PlayIcon />} disabled={actionsDisabled} onClick={onPlay}>{t('再生')}</Button>
        </DemoDisabledTip>
        <Button disabled={isOrigin} onClick={onExplore}>{t('この曲の近くを探す')}</Button>
        <DemoDisabledTip disabled={actionsDisabled}>
          <Button icon={<PlaylistAddIcon />} disabled={actionsDisabled} onClick={onSave}>{t('保存')}</Button>
        </DemoDisabledTip>
      </div>
    </section>
  );
}

const BAR_POSITION: CSSProperties = {
  bottom: 'calc(var(--floating-player-clearance, 0px) + var(--bottom-nav-height, 0px) + 8px)',
};

/** Under 640px: the selected dot as a 72px bar fixed above the mini player / bottom navigation. */
export function SoundMapSelectionBar(props: SoundMapSelectionProps) {
  const { point, song, isOrigin, playing, actionsDisabled, onPlay, onExplore } = props;
  const t = useTranslateSourceText();
  const meta = useSelectionText(point, song);
  // Toasts stay above this bar (72px + 8px gap) instead of covering the title and ▶.
  useRootLayoutVariable('--bottom-bar-clearance', '80px');

  return (
    <section
      aria-labelledby="sound-map-selected-title"
      className="fixed inset-x-2 z-[var(--z-sticky,20)] flex h-[72px] items-center gap-2 rounded-card bg-yt-raised py-2 pl-2 pr-1 shadow-[0_4px_24px_rgba(0,0,0,0.5)]"
      style={BAR_POSITION}
    >
      <SongThumbnail song={song} className="w-24" radius="sm" nowPlaying={playing} showDuration={false} />
      <div className="min-w-0 flex-1">
        <h2
          id="sound-map-selected-title"
          data-testid="sound-map-selected-title"
          className="m-0 truncate text-sm font-medium leading-5 text-yt-text"
        >
          {point.name}
        </h2>
        <p className="m-0 truncate text-xs leading-[18px] text-yt-text-secondary">{meta}</p>
      </div>
      <DemoDisabledTip disabled={actionsDisabled}>
        <IconButton label={t('再生')} icon={<PlayIcon />} variant="filled" className="size-11!" disabled={actionsDisabled} onClick={onPlay} />
      </DemoDisabledTip>
      <IconButton label={t('この曲の近くを探す')} icon={<ExploreNearbyIcon />} className="size-11!" disabled={isOrigin} onClick={onExplore} />
      <SelectionMenu {...props} includeSave />
    </section>
  );
}
