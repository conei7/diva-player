/**
 * Page chunks (DESIGN_SPEC §6.1.5). App renders every page with `lazy(() => loadRoute(key))`;
 * the guide and the bottom nav call `preloadRoute(path)` on hover / focus / touch so the chunk
 * is usually ready by the time the click lands, and `preloadMainRoutesWhenIdle()` warms the most
 * used pages after the first paint. A download is shared between all callers and retried after
 * a failure.
 */
const ROUTE_LOADERS = {
  home: () => import('../pages/HomePage'),
  watch: () => import('../pages/WatchPage'),
  playlists: () => import('../pages/PlaylistPage'),
  history: () => import('../pages/HistoryPage'),
  favorites: () => import('../pages/FavoritesPage'),
  favoriteProducers: () => import('../pages/FavoriteProducersPage'),
  reports: () => import('../pages/ReportsPage'),
  hiddenSongs: () => import('../pages/HiddenSongsPage'),
  chorusHighlights: () => import('../pages/ChorusHighlightsPage'),
  knowledgeMap: () => import('../pages/KnowledgeMapPage'),
  soundMap: () => import('../pages/SoundMapPage'),
} as const;

export type RouteKey = keyof typeof ROUTE_LOADERS;
type RouteModule<K extends RouteKey> = Awaited<ReturnType<(typeof ROUTE_LOADERS)[K]>>;

/** Router paths (without BASE_URL) → page chunk. */
const ROUTE_KEYS_BY_PATH: Readonly<Record<string, RouteKey>> = {
  '/': 'home',
  '/watch': 'watch',
  '/playing': 'watch',
  '/playlists': 'playlists',
  '/history': 'history',
  '/favorites': 'favorites',
  '/favorite-producers': 'favoriteProducers',
  '/reports': 'reports',
  '/settings/hidden-songs': 'hiddenSongs',
  '/chorus-highlights': 'chorusHighlights',
  '/knowledge-map': 'knowledgeMap',
  '/sound-map': 'soundMap',
};

/** The pages warmed after the first paint (home, song page, playlists, history). */
const IDLE_PRELOAD_ROUTES: readonly RouteKey[] = ['home', 'watch', 'playlists', 'history'];

const pendingLoads = new Map<RouteKey, Promise<unknown>>();

/** One shared download per page. A failed download is forgotten so the next call retries it. */
export function loadRoute<K extends RouteKey>(key: K): Promise<RouteModule<K>> {
  const existing = pendingLoads.get(key) as Promise<RouteModule<K>> | undefined;
  if (existing) return existing;
  const request = ROUTE_LOADERS[key]() as Promise<RouteModule<K>>;
  pendingLoads.set(key, request);
  request.catch(() => {
    if (pendingLoads.get(key) === request) pendingLoads.delete(key);
  });
  return request;
}

/** '/history?x=1' → 'history'. Unknown paths return null. */
export function routeKeyForPath(path: string): RouteKey | null {
  const pathname = path.split(/[?#]/, 1)[0].replace(/\/+$/, '') || '/';
  return ROUTE_KEYS_BY_PATH[pathname] ?? null;
}

/** Starts downloading the chunk of a router path (no-op for unknown paths). Never throws. */
export function preloadRoute(path: string): void {
  const key = routeKeyForPath(path);
  if (key) loadRoute(key).catch(() => {});
}

function prefersReducedData(): boolean {
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
  return connection?.saveData === true;
}

/**
 * Downloads the main pages one by one while the browser is idle (requestIdleCallback, or
 * 2 seconds apart where it is missing). Returns a cancel function for effect cleanup.
 */
export function preloadMainRoutesWhenIdle(): () => void {
  if (typeof window === 'undefined' || prefersReducedData()) return () => {};
  const queue = [...IDLE_PRELOAD_ROUTES];
  let cancelled = false;
  let timer: number | undefined;
  let idleHandle: number | undefined;

  const schedule = () => {
    if (cancelled || queue.length === 0) return;
    if (typeof window.requestIdleCallback === 'function') {
      idleHandle = window.requestIdleCallback(runNext, { timeout: 5000 });
    } else {
      timer = window.setTimeout(runNext, 2000);
    }
  };
  function runNext() {
    if (cancelled) return;
    const key = queue.shift();
    if (!key) return;
    loadRoute(key).catch(() => {}).finally(schedule);
  }

  schedule();
  return () => {
    cancelled = true;
    if (timer !== undefined) window.clearTimeout(timer);
    if (idleHandle !== undefined && typeof window.cancelIdleCallback === 'function') window.cancelIdleCallback(idleHandle);
  };
}

/**
 * Runs `task` once the browser is idle (requestIdleCallback, or after 2 seconds where it is
 * missing). Used to warm the frame's deferred parts (menus) after the first paint. Returns a
 * cancel function for effect cleanup.
 */
export function whenIdle(task: () => void): () => void {
  if (typeof window === 'undefined' || prefersReducedData()) return () => {};
  if (typeof window.requestIdleCallback === 'function') {
    const handle = window.requestIdleCallback(() => task(), { timeout: 5000 });
    return () => {
      if (typeof window.cancelIdleCallback === 'function') window.cancelIdleCallback(handle);
    };
  }
  const timer = window.setTimeout(task, 2000);
  return () => window.clearTimeout(timer);
}

/** The router path of the current document (BASE_URL removed). */
function initialRouterPath(): string {
  const base = (import.meta.env.BASE_URL ?? '/').replace(/\/+$/, '');
  const pathname = window.location.pathname;
  const withoutBase = base && (pathname === base || pathname.startsWith(`${base}/`))
    ? pathname.slice(base.length)
    : pathname;
  return withoutBase || '/';
}

// Start the entry page's download while App is still being evaluated instead of waiting for
// the first React render (most visits start on Home).
if (typeof window !== 'undefined') preloadRoute(initialRouterPath());
