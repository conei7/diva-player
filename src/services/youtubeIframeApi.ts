declare global {
  interface Window {
    YT: {
      Player: new (elementId: string | HTMLElement, options: YT.PlayerOptions) => YT.Player;
      PlayerState: { UNSTARTED: number; ENDED: number; PLAYING: number; PAUSED: number; BUFFERING: number; CUED: number };
    };
    onYouTubeIframeAPIReady: () => void;
  }
}

let pending: Promise<void> | undefined;

export function loadYouTubeAPI(): Promise<void> {
  if (window.YT?.Player) return Promise.resolve();
  if (pending) return pending;

  pending = new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    const onReady = () => {
      clearTimeout(timeout);
      resolve();
    };
    const fail = () => {
      clearTimeout(timeout);
      script.remove();
      pending = undefined;
      reject(new Error('YouTube player API unavailable'));
    };
    const timeout = window.setTimeout(fail, 15000);
    script.src = 'https://www.youtube.com/iframe_api';
    script.onerror = fail;
    window.onYouTubeIframeAPIReady = onReady;
    document.head.append(script);
  });
  return pending;
}
