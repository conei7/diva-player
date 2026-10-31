import { useSyncExternalStore } from 'react';
import { useUiLayoutStore } from '../stores/uiLayoutStore';
import { getMusicShell, subscribeMusicShell } from '../components/music/musicShellLoader';

/**
 * The music frame's module while the music layout is in use, otherwise null. The module is loaded
 * before the layout is switched on (main.tsx, Settings, other tabs); if its download failed this
 * session shows the standard layout without changing the saved choice, until a later try succeeds.
 */
export function useMusicShell() {
  const layout = useUiLayoutStore(state => state.layout);
  const shell = useSyncExternalStore(subscribeMusicShell, getMusicShell, getMusicShell);
  return layout === 'music' ? shell ?? null : null;
}

export function useIsMusicLayout(): boolean {
  return useMusicShell() !== null;
}
