import { focusElement } from '../ui/overlay';

/** Layout's <main>. */
export const MAIN_CONTENT_ID = 'main-content';

/**
 * Focus <main>: the skip link メインコンテンツへ移動, and controls that go away under the keyboard with
 * nowhere better to go (the music layout's player bar on the song page of a short window).
 */
export function focusMainContent() {
  const main = document.getElementById(MAIN_CONTENT_ID);
  if (!main) return;
  // Focusable only for the jump: a lasting tabindex would make every click on the page focus <main>.
  if (!main.hasAttribute('tabindex')) {
    main.tabIndex = -1;
    main.addEventListener('blur', () => main.removeAttribute('tabindex'), { once: true });
  }
  focusElement(main);
}
