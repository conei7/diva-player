/**
 * The music layout's frame is a separate chunk (outside the initial JavaScript). It is loaded before
 * the layout is switched on, then rendered from this cache synchronously, so switching never shows a
 * Suspense fallback and never remounts the page. A failed download is forgotten so the next try loads again.
 */
type MusicShellModule = typeof import('./MusicShell');

let musicShell: MusicShellModule | undefined;
let musicShellPromise: Promise<MusicShellModule> | undefined;
const listeners = new Set<() => void>();

export function getMusicShell(): MusicShellModule | undefined {
  return musicShell;
}

/** For useSyncExternalStore: a download that succeeds after a failed start shows the frame at once. */
export function subscribeMusicShell(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function ensureMusicShell(): Promise<MusicShellModule> {
  if (musicShell) return Promise.resolve(musicShell);
  musicShellPromise ??= import('./MusicShell').then(module => {
    musicShell = module;
    listeners.forEach(listener => listener());
    return module;
  }).catch(error => {
    musicShellPromise = undefined;
    throw error;
  });
  return musicShellPromise;
}
