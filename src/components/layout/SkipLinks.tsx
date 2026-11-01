import { useTranslateSourceText } from '../../i18n';
import { usePlayerStore } from '../../stores/playerStore';
import { cx, focusElement } from '../ui/overlay';
import { focusMainContent } from './mainContent';

// The play button of whichever player is on screen: the music player bar, the music mini bar on
// phones, or the standard mini player. Hidden ones (display: none, inert, disabled) are passed over.
const PLAYER_TARGET_SELECTOR = [
  '[data-testid="music-play-toggle"]',
  '[data-testid="music-mini-play-toggle"]',
  '[data-testid="global-mini-player-toggle"]',
].join(', ');

const SKIP_CLASS = cx(
  'sr-only cursor-pointer rounded-chip bg-yt-inverse text-sm font-medium leading-5 text-yt-on-inverse',
  // not-sr-only resets the padding, so the padding takes the same variant.
  'focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-[var(--z-toast,100)] focus:px-4 focus:py-2',
);

function focusPlayer() {
  const target = Array.from(document.querySelectorAll<HTMLElement>(PLAYER_TARGET_SELECTOR)).find(element => (
    element.getClientRects().length > 0 && !element.matches(':disabled') && !element.closest('[inert]')
  ));
  if (target) {
    focusElement(target);
    return;
  }
  // No play button on screen (the song page has none, apart from the music layout's player bar on
  // windows 640px wide and 420px tall or more): the video itself, so its own controls take the keys.
  // It is in a portal after <main> and its endless related list. Not in the selector above: in
  // document order the mini player's iframe would beat its play button. The parked player (1px), one
  // kept under the page's frame (inert) and the idle YouTube iframe behind another service's video
  // are passed over.
  const video = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="global-player"] iframe')).find(element => (
    element.getBoundingClientRect().width > 1 && !element.closest('[inert],[aria-hidden="true"]')
  ));
  if (video) {
    // focus() does not scroll to an iframe (and focusElement prevents scrolling). Scrolled only when
    // part of it is under the fixed top bar (or the selection bar below it) or below the window, and
    // no further than needed. Its top never goes under the bars: a video taller than the room below
    // them keeps its top just below them.
    const { top, bottom } = video.getBoundingClientRect();
    const barsBottom = Math.max(0, ...['header', '[data-testid="selection-fab"]'].map(selector => (
      document.querySelector(selector)?.getBoundingClientRect().bottom ?? 0
    )));
    window.scrollBy(0, Math.min(Math.floor(top - barsBottom), Math.max(0, Math.ceil(bottom - window.innerHeight))));
    focusElement(video);
    return;
  }
  focusMainContent();
}

/**
 * The first Tab stops of the frame (WCAG 2.4.1): past the top bar and the guide or library to the page,
 * and, while a song is loaded, to the player that comes after the endless lists (its play button, or
 * on the song page the video; else the page). Shown only while focused.
 * Buttons rather than #main-content links: a hash navigation would add a history entry and a new
 * location.key, which Layout and the Home feed snapshot key off.
 */
export default function SkipLinks() {
  const t = useTranslateSourceText();
  const hasSong = usePlayerStore(state => state.currentSong !== null);
  return (
    <>
      <button type="button" className={SKIP_CLASS} onClick={focusMainContent}>
        {t('メインコンテンツへ移動')}
      </button>
      {hasSong && (
        <button type="button" className={SKIP_CLASS} onClick={focusPlayer}>
          {t('プレイヤーへ移動')}
        </button>
      )}
    </>
  );
}
