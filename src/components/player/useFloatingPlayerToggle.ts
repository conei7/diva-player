import { usePlayerInteractionStore } from '../../stores/playerInteractionStore';
import { isFloatingPlayerSupported, toggleFloatingPlayer, useFloatingPlayerStore } from '../../services/floatingPlayerWindow';

/**
 * The 小窓プレイヤー buttons (music player bar, ⋮ menus): shown only while 設定 > 全般 > 小窓プレイヤー is
 * on in a browser that has the window. `toggle` must run in the click itself (a user gesture).
 */
export function useFloatingPlayerToggle(): { available: boolean; open: boolean; toggle: () => void } {
  const enabled = usePlayerInteractionStore(state => state.floatingPlayerEnabled);
  const open = useFloatingPlayerStore(state => state.window !== null);
  return {
    available: enabled && isFloatingPlayerSupported(),
    open,
    toggle: () => { void toggleFloatingPlayer(); },
  };
}
