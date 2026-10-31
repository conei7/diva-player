import { useTranslateSourceText } from '../../i18n';
import { usePlayerStore } from '../../stores/playerStore';
import { cx, focusElement } from '../ui/overlay';

/** Layout's <main>. */
export const MAIN_CONTENT_ID = 'main-content';

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

function focusMainContent() {
  const main = document.getElementById(MAIN_CONTENT_ID);
  if (!main) return;
  // Focusable only for the jump: a lasting tabindex would make every click on the page focus <main>.
  if (!main.hasAttribute('tabindex')) {
    main.tabIndex = -1;
    main.addEventListener('blur', () => main.removeAttribute('tabindex'), { once: true });
  }
  focusElement(main);
}

function focusPlayer() {
  const target = Array.from(document.querySelectorAll<HTMLElement>(PLAYER_TARGET_SELECTOR)).find(element => (
    element.getClientRects().length > 0 && !element.matches(':disabled') && !element.closest('[inert]')
  ));
  // No player control on screen (the standard song page plays inside <main>): go to the page instead.
  if (target) focusElement(target);
  else focusMainContent();
}

/**
 * The first Tab stops of the frame (WCAG 2.4.1): past the top bar and the guide or library to the page,
 * and, while a song is loaded, to the player that comes after the endless lists. Shown only while focused.
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
