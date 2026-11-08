import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { usePlayerInteractionStore } from '../../stores/playerInteractionStore';
import { usePlayerStore } from '../../stores/playerStore';
import {
  closeFloatingPlayer,
  isFloatingPlayerSupported,
  openFloatingPlayer,
  syncRootAttributes,
  useFloatingPlayerStore,
} from '../../services/floatingPlayerWindow';
import FloatingPlayerView from './FloatingPlayerView';

/** Chrome 134+ (the DOM typings in use do not list it yet). */
const ENTER_PICTURE_IN_PICTURE = 'enterpictureinpicture' as MediaSessionAction;

/**
 * 小窓プレイヤー (設定 > 全般). While it is on and a song is loaded, the browser may open the window by
 * itself when the user switches tabs or minimizes the window (Chrome's automatic picture-in-picture:
 * the 'enterpictureinpicture' media session action, subject to the browser's own conditions and site
 * setting). The buttons open it with a click. Turning the setting off, or closing the player, closes
 * the window. Lazy-loaded after the first render, like MediaSession.
 */
export default function FloatingPlayerHost() {
  const enabled = usePlayerInteractionStore(state => state.floatingPlayerEnabled);
  const hasSong = usePlayerStore(state => state.currentSong !== null);
  const pip = useFloatingPlayerStore(state => state.window);

  useEffect(() => {
    if (!enabled || !hasSong || !isFloatingPlayerSupported() || !('mediaSession' in navigator)) return undefined;
    try {
      navigator.mediaSession.setActionHandler(ENTER_PICTURE_IN_PICTURE, () => {
        void openFloatingPlayer();
      });
    } catch {
      // A browser without the action rejects it: the buttons still open the window.
      return undefined;
    }
    return () => {
      try {
        navigator.mediaSession.setActionHandler(ENTER_PICTURE_IN_PICTURE, null);
      } catch {
        // Nothing was registered.
      }
    };
  }, [enabled, hasSong]);

  useEffect(() => {
    if (!enabled || !hasSong) closeFloatingPlayer();
  }, [enabled, hasSong]);

  // The theme, accent colour and language switched in the page follow into the window.
  useEffect(() => {
    if (!pip) return undefined;
    const sync = () => syncRootAttributes(document.documentElement, pip.document.documentElement);
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(document.documentElement, { attributes: true });
    return () => observer.disconnect();
  }, [pip]);

  if (!pip || pip.closed) return null;
  return createPortal(<FloatingPlayerView ownerWindow={pip} />, pip.document.body);
}
