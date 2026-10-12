import type { Song } from '../../types/vocadb';
import { usePlayerStore } from '../../stores/playerStore';
import { isPlayablePV } from '../../utils/playablePV';
import { useTranslate, useTranslateSourceText } from '../../i18n';
import { useLanguageStore } from '../../stores/languageStore';
import { ChevronDownIcon, PlayIcon } from '../ui/icons';
import { cx } from '../ui/overlay';
import { videoSourceLabel, withVideoName } from '../watch/videoLabels';

interface PVSourceSelectorProps {
  song?: Song | null;
  /** Narrower pill (kept for older callers). */
  compact?: boolean;
}

type PlayablePV = NonNullable<Song['pvs']>[number];

function pvKey(pv: PlayablePV): string {
  return `${pv.service}:${pv.pvId || pv.id}`;
}

/**
 * 再生する動画の切替（tonal の pill の見た目をした select）。
 * 選択肢は「YouTube（公式）」「ニコニコ（転載）」/ 'YouTube (official)'。同じサービス・種別が複数ある時だけ短い動画名を足す。
 * PV が 2 つ以上あり、この曲を再生中の時だけ出す。
 */
export default function PVSourceSelector({ song, compact = false }: PVSourceSelectorProps) {
  const tk = useTranslate();
  const t = useTranslateSourceText();
  const language = useLanguageStore(state => state.language);
  const currentSong = usePlayerStore(state => state.currentSong);
  const currentPV = usePlayerStore(state => state.currentPV);
  const selectPV = usePlayerStore(state => state.selectPV);
  const targetSong = song ?? currentSong;
  const playablePVs = targetSong?.pvs?.filter(isPlayablePV) ?? [];

  if (!targetSong || playablePVs.length < 2 || currentSong?.id !== targetSong.id) return null;

  const baseLabel = (pv: PlayablePV): string => videoSourceLabel(pv, language, t);
  /** In the list, a short video name tells apart several videos of the same service and kind. */
  const optionLabel = (pv: PlayablePV): string => withVideoName(baseLabel(pv), pv, playablePVs, language);

  const currentKey = currentPV ? `${currentPV.service}:${currentPV.pvId || currentPV.id}` : '';
  const selected = playablePVs.find(pv => pvKey(pv) === currentKey) ?? playablePVs[0];

  return (
    <span
      className={cx(
        'relative inline-flex h-9 min-w-0 shrink-0 items-center gap-1.5 rounded-full bg-yt-tonal pl-3 pr-2 text-sm font-medium leading-5 text-yt-text transition-colors duration-150 hover:bg-yt-tonal-hover',
        'has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-yt-focus',
        compact ? 'max-w-[12rem]' : 'max-w-[16rem]',
      )}
    >
      <PlayIcon size={20} />
      <span aria-hidden="true" className="min-w-0 truncate">{baseLabel(selected)}</span>
      <ChevronDownIcon size={20} />
      <select
        className="absolute inset-0 h-full w-full cursor-pointer appearance-none rounded-full opacity-0"
        value={currentKey}
        onChange={event => {
          const next = playablePVs.find(pv => pvKey(pv) === event.target.value);
          if (next) selectPV(next);
        }}
        aria-label={tk('pvSelectorAria')}
        style={{ colorScheme: 'dark' }}
      >
        {playablePVs.map(pv => (
          <option
            key={pvKey(pv)}
            value={pvKey(pv)}
            style={{ background: 'var(--color-yt-menu)', color: 'var(--color-yt-text)' }}
          >
            {optionLabel(pv)}
          </option>
        ))}
      </select>
    </span>
  );
}
