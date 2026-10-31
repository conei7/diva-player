import { useId } from 'react';
import type { CSSProperties } from 'react';
import { useTranslateSourceText } from '../../../i18n';
import { usePlayerStore } from '../../../stores/playerStore';
import { isSilentVolume, setVolumeFromApp } from '../../player/playerMute';
import IconButton from '../../ui/IconButton';
import { VolumeOffIcon, VolumeUpIcon } from '../../ui/icons';
import { cx } from '../../ui/overlay';
import Tooltip from '../../ui/Tooltip';
import { ignoresAppVolume, SOFT_DISABLED_CLASS, toggleMuteWithToast } from './playerBarUi';

/**
 * A thin range input drawn like the progress line: brand-colored up to the volume, a round knob, and
 * a 40px tall hit area (touch screens from 1024px). Firefox fills with ::-moz-range-progress, WebKit with a
 * gradient at --music-volume.
 */
const SLIDER_CLASS = cx(
  'block h-10 w-full min-w-0 cursor-pointer appearance-none bg-transparent',
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-yt-focus',
  'disabled:pointer-events-none disabled:cursor-default disabled:opacity-40',
  '[&::-webkit-slider-runnable-track]:h-1 [&::-webkit-slider-runnable-track]:rounded-full',
  '[&::-webkit-slider-runnable-track]:bg-[linear-gradient(to_right,var(--color-brand)_var(--music-volume),var(--color-yt-outline)_var(--music-volume))]',
  '[&::-webkit-slider-thumb]:-mt-1 [&::-webkit-slider-thumb]:size-3 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border-0 [&::-webkit-slider-thumb]:bg-yt-text',
  '[&::-moz-range-track]:h-1 [&::-moz-range-track]:rounded-full [&::-moz-range-track]:bg-yt-outline',
  '[&::-moz-range-progress]:h-1 [&::-moz-range-progress]:rounded-full [&::-moz-range-progress]:bg-brand',
  '[&::-moz-range-thumb]:size-3 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-yt-text',
);

interface PlayerBarVolumeProps {
  /** The slider next to the mute button (from 1024px; below it only the button). */
  showSlider: boolean;
}

/**
 * Mute and volume. The button mutes in memory only and says so in a toast, like M. The slider ends a
 * mute and saves the volume (setVolumeFromApp). The music layout puts no badge on the video, so the
 * crossed-out speaker here is the sign that nothing can be heard. Bilibili takes no volume from the
 * app: both are disabled then and say why.
 */
export default function PlayerBarVolume({ showSlider }: PlayerBarVolumeProps) {
  const t = useTranslateSourceText();
  const hasSong = usePlayerStore(state => state.currentSong !== null);
  const service = usePlayerStore(state => state.currentPV?.service);
  const volume = usePlayerStore(state => state.volume);
  const noteId = useId();
  const silent = isSilentVolume(volume);
  const unsupported = hasSong && ignoresAppVolume(service);
  const unsupportedNote = t('Bilibiliの動画は、動画のプレイヤーで音量を変えてください');
  const sliderStyle = { '--music-volume': `${volume}%` } as CSSProperties;

  const slider = (
    <input
      type="range"
      min={0}
      max={100}
      step={1}
      value={volume}
      aria-label={t('音量')}
      // Niconico can report a fractional volume.
      aria-valuetext={`${Math.round(volume)}%`}
      aria-describedby={unsupported ? noteId : undefined}
      disabled={!hasSong || unsupported}
      className={SLIDER_CLASS}
      style={sliderStyle}
      onChange={event => setVolumeFromApp(Number(event.currentTarget.value))}
    />
  );

  return (
    <div className="flex min-w-0 items-center">
      <IconButton
        label={silent ? t('ミュートを解除') : t('ミュート')}
        icon={silent ? <VolumeOffIcon /> : <VolumeUpIcon />}
        disabled={!hasSong}
        aria-disabled={unsupported || undefined}
        aria-describedby={unsupported ? noteId : undefined}
        tooltip={unsupported ? unsupportedNote : undefined}
        tooltipPlacement="left"
        className={SOFT_DISABLED_CLASS}
        data-testid="music-mute-toggle"
        onClick={() => { if (!unsupported) toggleMuteWithToast(t); }}
      />
      {showSlider && (
        <div className="mr-1 w-24 min-w-0">
          {unsupported ? (
            // A disabled input gets no pointer events: the wrapper shows why it is disabled.
            <Tooltip content={unsupportedNote} placement="left">
              <span className="block">{slider}</span>
            </Tooltip>
          ) : slider}
        </div>
      )}
      {unsupported && <span id={noteId} hidden>{unsupportedNote}</span>}
    </div>
  );
}
