/**
 * 小窓プレイヤー: a small always-on-top player window (Document Picture-in-Picture, Chrome / Edge
 * 116+ on computers), like Spotify's miniplayer. The window shows the song and its controls only; the
 * video keeps playing in the page (its iframe cannot move to another document without reloading).
 * FloatingPlayerHost renders into the window and registers the browser's automatic opening.
 */
import { create } from 'zustand';
import type { Song } from '../types/vocadb';
import { getSquareSongThumbnailCandidates } from '../utils/songThumbnail';

interface DocumentPictureInPictureOptions {
  width?: number;
  height?: number;
  disallowReturnToOpener?: boolean;
  preferInitialWindowPlacement?: boolean;
}

export interface DocumentPictureInPictureApi {
  requestWindow: (options?: DocumentPictureInPictureOptions) => Promise<Window>;
  readonly window: Window | null;
}

/** The first size; the user can resize the window, and the view adapts (FloatingPlayerView). */
export const FLOATING_PLAYER_SIZE = { width: 320, height: 320 } as const;

/** Wider than 1.6:1 the artwork goes left of the text and controls; otherwise it fills the window. */
export type FloatingPlayerShape = 'stacked' | 'row';

export function floatingPlayerShape(width: number, height: number): FloatingPlayerShape {
  return width >= height * 1.6 ? 'row' : 'stacked';
}

/**
 * The artwork is larger here than anywhere in the page, so YouTube's HD thumbnail goes first; videos
 * without one get a 404 or a 120px placeholder (the view skips both), then the page's usual candidates.
 */
export function floatingArtworkCandidates(song: Pick<Song, 'thumbUrl' | 'pvs'>): string[] {
  const candidates = getSquareSongThumbnailCandidates(song);
  const hd = candidates
    .filter(url => url.endsWith('/mqdefault.jpg'))
    .map(url => url.replace(/\/mqdefault\.jpg$/, '/maxresdefault.jpg'));
  return [...hd, ...candidates];
}

export function getDocumentPictureInPicture(scope: object = globalThis): DocumentPictureInPictureApi | null {
  const api = (scope as { documentPictureInPicture?: Partial<DocumentPictureInPictureApi> }).documentPictureInPicture;
  return api && typeof api.requestWindow === 'function' ? api as DocumentPictureInPictureApi : null;
}

export function isFloatingPlayerSupported(): boolean {
  return getDocumentPictureInPicture() !== null;
}

interface FloatingPlayerState {
  /** The open window, or null. */
  window: Window | null;
}

export const useFloatingPlayerStore = create<FloatingPlayerState>(() => ({ window: null }));

let opening: Promise<boolean> | null = null;

/**
 * The page's styles in the window: same-origin sheets as their rules (built CSS, dev-server <style>),
 * others (web fonts) as links. Tailwind's single stylesheet holds the window's classes too.
 */
export function copyDocumentStyles(source: Document, target: Document): void {
  for (const sheet of Array.from(source.styleSheets)) {
    let rules: string | null = null;
    try {
      rules = Array.from(sheet.cssRules, rule => rule.cssText).join('\n');
    } catch {
      // A cross-origin sheet hides its rules: link to it instead.
    }
    if (rules !== null) {
      const style = target.createElement('style');
      style.textContent = rules;
      target.head.append(style);
    } else if (sheet.href) {
      const link = target.createElement('link');
      link.rel = 'stylesheet';
      link.href = sheet.href;
      if (sheet.media.mediaText) link.media = sheet.media.mediaText;
      target.head.append(link);
    }
  }
}

/** Theme (data-theme), accent colour (style), language and classes follow the page's <html>. */
export function syncRootAttributes(source: Element, target: Element): void {
  for (const name of target.getAttributeNames()) {
    if (!source.hasAttribute(name)) target.removeAttribute(name);
  }
  for (const name of source.getAttributeNames()) {
    const value = source.getAttribute(name) ?? '';
    if (target.getAttribute(name) !== value) target.setAttribute(name, value);
  }
}

function prepareWindow(pip: Window): void {
  copyDocumentStyles(document, pip.document);
  syncRootAttributes(document.documentElement, pip.document.documentElement);
  pip.document.title = document.title;
  pip.document.body.className = 'm-0 overflow-hidden bg-neutral-950';
}

/**
 * Opens the window, or focuses it when it is open. Must run in a user gesture (a click) or in the
 * browser's 'enterpictureinpicture' media session action. False when the browser has no such window
 * or refused it.
 */
export function openFloatingPlayer(api: DocumentPictureInPictureApi | null = getDocumentPictureInPicture()): Promise<boolean> {
  if (!api) return Promise.resolve(false);
  const current = useFloatingPlayerStore.getState().window;
  if (current && !current.closed) {
    current.focus();
    return Promise.resolve(true);
  }
  if (opening) return opening;
  opening = (async () => {
    try {
      const pip = await api.requestWindow(FLOATING_PLAYER_SIZE);
      prepareWindow(pip);
      pip.addEventListener('pagehide', () => {
        if (useFloatingPlayerStore.getState().window === pip) useFloatingPlayerStore.setState({ window: null });
      }, { once: true });
      useFloatingPlayerStore.setState({ window: pip });
      return true;
    } catch {
      return false;
    } finally {
      opening = null;
    }
  })();
  return opening;
}

export function closeFloatingPlayer(): void {
  const current = useFloatingPlayerStore.getState().window;
  useFloatingPlayerStore.setState({ window: null });
  if (current && !current.closed) current.close();
}

/** The bar's toggle button and the ⋮ item. */
export function toggleFloatingPlayer(): Promise<boolean> {
  const current = useFloatingPlayerStore.getState().window;
  if (current && !current.closed) {
    closeFloatingPlayer();
    return Promise.resolve(false);
  }
  return openFloatingPlayer();
}
