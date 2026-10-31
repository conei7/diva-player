import { useEffect, useMemo, useRef, useState } from 'react';
import type { Song } from '../../../types/vocadb';
import { useTranslateSourceText } from '../../../i18n';
import { usePlayerStore } from '../../../stores/playerStore';
import { getWideSongThumbnailCandidates } from '../../../utils/songThumbnail';
import IconButton from '../../ui/IconButton';
import { MusicNoteIcon, PlayIcon } from '../../ui/icons';
import { useLatest } from '../../ui/overlay';
import { useLocalPlayback } from './useLocalPlayback';

/** The song's 16:9 thumbnail filling the slot (next image on error, none in hidden mode). */
function SlotArtwork({ song }: { song: Song }) {
  const hiddenMode = usePlayerStore(state => state.hiddenMode);
  const candidates = useMemo(() => getWideSongThumbnailCandidates(song), [song]);
  const signature = candidates.join('\u0000');
  const [failure, setFailure] = useState({ signature, index: 0 });
  const imageIndex = failure.signature === signature ? failure.index : 0;
  const imageUrl = hiddenMode ? undefined : candidates[imageIndex];

  if (!imageUrl) {
    return (
      <div aria-hidden="true" className="absolute inset-0 flex items-center justify-center bg-yt-tonal-solid text-yt-text-disabled">
        <MusicNoteIcon size={48} />
      </div>
    );
  }
  return (
    <img
      key={imageUrl}
      src={imageUrl}
      alt=""
      decoding="async"
      draggable={false}
      className="absolute inset-0 h-full w-full object-cover"
      onError={() => setFailure(previous => ({
        signature,
        index: (previous.signature === signature ? previous.index : 0) + 1,
      }))}
    />
  );
}

interface NowPlayingVideoSlotProps {
  song: Song;
  /** Where the keyboard goes when 再生 succeeds and the video takes over the slot (the button is gone). */
  onButtonGone?: () => void;
}

/**
 * The box GlobalPlayer lays the video over (.music-docked-player has the same position and size: right
 * under the panel's 48px head, the panel width minus 12px on each side). Under the video: the song's
 * thumbnail. While this tab does not play (another tab does, or a restored queue is paused), the video
 * is not here and a play button takes playback to this tab. While it plays here nothing in the slot
 * can be reached or needs a click (the video covers all of it).
 */
export default function NowPlayingVideoSlot({ song, onButtonGone }: NowPlayingVideoSlotProps) {
  const t = useTranslateSourceText();
  const resume = usePlayerStore(state => state.resume);
  const { ownership, hasLocalPlayback } = useLocalPlayback();
  const buttonFocusedRef = useRef(false);
  const onButtonGoneRef = useLatest(onButtonGone);

  // A removed button does not report blur: when it had the keyboard, move it on instead of <body>
  // (where Space would toggle playback again).
  useEffect(() => {
    if (!hasLocalPlayback || !buttonFocusedRef.current) return;
    buttonFocusedRef.current = false;
    const active = document.activeElement;
    if (!active || active === document.body || active === document.documentElement) onButtonGoneRef.current?.();
  }, [hasLocalPlayback, onButtonGoneRef]);

  const otherTab = ownership === 'remote';
  const label = otherTab ? t('このタブで再生') : t('再生');

  return (
    <div className="music-video-slot" data-testid="music-video-slot">
      <SlotArtwork song={song} />
      {!hasLocalPlayback && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/50 px-4 text-center">
          <IconButton
            label={label}
            icon={<PlayIcon />}
            variant="filled"
            size="lg"
            data-testid="music-now-playing-resume"
            className="size-14! shadow-[0_2px_12px_rgba(0,0,0,0.4)] [&_[data-icon]>svg]:size-8!"
            onFocus={() => { buttonFocusedRef.current = true; }}
            onBlur={() => { buttonFocusedRef.current = false; }}
            onClick={resume}
          />
          {otherTab && (
            <p className="m-0 text-sm font-medium leading-5 text-white [text-shadow:0_1px_2px_rgba(0,0,0,0.6)]">
              {t('別のタブで再生中です')}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
