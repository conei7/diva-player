const LEGACY_TUNNEL_KEY = 'quick_tunnel_url';
const PRIMARY_TUNNEL_KEY = 'quick_tunnel_primary_url';
const QUICK_TUNNEL_PATTERN = /^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/i;
const ORIGIN_TIMEOUT_MS = 15_000;

function configurationError(message) {
  return Response.json({ error: message }, { status: 503 });
}

function parseNamedOrigin(value, incomingHostname) {
  if (typeof value !== 'string' || value.trim() === '') return null;

  try {
    const origin = new URL(value.trim());
    const hostname = origin.hostname.toLowerCase();
    const isIpLiteral = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname) || hostname.includes(':');
    if (
      origin.protocol !== 'https:'
      || origin.username
      || origin.password
      || origin.pathname !== '/'
      || origin.search
      || origin.hash
      || hostname === incomingHostname.toLowerCase()
      || hostname === 'localhost'
      || hostname.endsWith('.localhost')
      || hostname === 'pages.dev'
      || hostname.endsWith('.pages.dev')
      || hostname.endsWith('.')
      || isIpLiteral
      || QUICK_TUNNEL_PATTERN.test(origin.origin)
    ) return null;
    return origin.origin;
  } catch {
    return null;
  }
}

async function readTunnelRecord(kv, key) {
  if (!kv) return { value: null, metadata: null };
  if (typeof kv.getWithMetadata === 'function') {
    const record = await kv.getWithMetadata(key, { cacheTtl: 60 });
    return {
      value: record?.value ?? null,
      metadata: record?.metadata ?? null,
    };
  }
  return {
    value: await kv.get(key, { cacheTtl: 60 }),
    metadata: null,
  };
}

async function resolveOrigin(env, incoming) {
  const mode = (env.DIVA_API_ORIGIN_MODE || 'quick').trim().toLowerCase();
  if (mode === 'named') {
    const origin = parseNamedOrigin(env.DIVA_NAMED_TUNNEL_ORIGIN, incoming.hostname);
    if (!origin) return { error: 'named tunnel origin is not configured safely' };
    if (!env.CF_ACCESS_CLIENT_ID || !env.CF_ACCESS_CLIENT_SECRET) {
      return { error: 'named tunnel access credentials are not configured' };
    }
    return {
      mode,
      origin,
    };
  }

  if (mode !== 'quick') return { error: 'unsupported API origin mode' };
  const [configuredPrimary, legacyPrimary] = await Promise.all([
    readTunnelRecord(env.TUNNEL_CONFIG, PRIMARY_TUNNEL_KEY),
    readTunnelRecord(env.TUNNEL_CONFIG, LEGACY_TUNNEL_KEY),
  ]);
  const primary = configuredPrimary.value || legacyPrimary.value;
  if (!primary || !QUICK_TUNNEL_PATTERN.test(primary)) {
    return { error: 'SBC tunnel is not registered' };
  }
  return {
    mode,
    origin: primary,
  };
}

function buildTarget(origin, mode, incoming) {
  const upstreamPath = mode === 'named'
    ? incoming.pathname.replace(/^\/backend-api(?=\/|$)/, '') || '/'
    : incoming.pathname;
  const target = new URL(origin);
  target.pathname = upstreamPath;
  target.search = incoming.search;
  return target;
}

function proxyHeaders(request, env, mode) {
  const headers = new Headers(request.headers);
  headers.delete('host');
  headers.delete('x-diva-client-key');
  headers.delete('x-forwarded-for');
  headers.delete('x-real-ip');
  headers.delete('x-forwarded-proto');
  headers.delete('cf-access-client-id');
  headers.delete('cf-access-client-secret');
  headers.delete('x-diva-origin-role');
  headers.delete('x-diva-standby-state');
  const clientIp = request.headers.get('cf-connecting-ip') || 'pages-anonymous';
  headers.set('x-diva-client-key', clientIp);
  headers.set('x-diva-pages-proxy', '1');
  headers.delete('x-diva-pages-proxy-key');
  headers.set('x-diva-pages-proxy-key', env.PAGES_PROXY_KEY);
  if (mode === 'named') {
    headers.set('cf-access-client-id', env.CF_ACCESS_CLIENT_ID);
    headers.set('cf-access-client-secret', env.CF_ACCESS_CLIENT_SECRET);
  }
  return headers;
}

function observableResponse(response) {
  const headers = new Headers(response.headers);
  // These values describe the routing decision made by this Function. Never
  // trust or forward identically named headers supplied by an upstream.
  headers.set('X-Diva-Origin-Role', 'primary');
  headers.set('X-Diva-Standby-State', 'missing');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function fetchOrigin(target, init, incomingSignal) {
  const timeoutSignal = AbortSignal.timeout(ORIGIN_TIMEOUT_MS);
  const signal = incomingSignal
    ? AbortSignal.any([incomingSignal, timeoutSignal])
    : timeoutSignal;
  // Keep the composite signal owned by fetch/Response instead of clearing a
  // timer when only the response headers arrive.  Both the caller abort and
  // the 15-second deadline therefore remain effective while the body streams.
  return fetch(target, { ...init, signal });
}

// The API marks responses that depend only on their URL (recommendations, rankings, search,
// song cards) with a public s-maxage. Keeping them at the edge answers repeated requests
// without the tunnel round trip to the SBC. Everything else is never stored.
const EDGE_CACHEABLE = /(?:^|,)\s*public\s*(?:,|$)/i;
const EDGE_MAX_AGE = /(?:^|,)\s*s-maxage=(\d+)/i;

// Read-only GET endpoints whose answer depends only on the URL, never on the caller. They are
// kept for EDGE_DEFAULT_SECONDS even when an older API sends no cache headers. Personal or
// policy answers (discovery-eligibility, health, playlists) are not listed and never stored.
const EDGE_DEFAULT_SECONDS = 120;
// Recommendations change only when the pipeline publishes a new generation (about daily), and a
// cold one costs the SBC seconds. Home rechecks every candidate's eligibility itself.
const EDGE_RECOMMENDATION_SECONDS = 600;
const EDGE_RECOMMENDATION_PATHS = /^\/backend-api\/api\/recommend(?:\/(?:audio|similar|producer|metadata))?$/;
const EDGE_SHARED_PATHS = /^\/backend-api\/api\/(?:songs\/(?:search|trending|batch|details|views)|search\/tags)$/;
const EDGE_REFUSED = /(?:^|,)\s*(?:no-store|private|no-cache)\s*(?:,|$)/i;

function edgeLifetime(pathname, response) {
  if (response.status !== 200 || response.headers.has('set-cookie')) return 0;
  const cacheControl = response.headers.get('cache-control') ?? '';
  if (EDGE_REFUSED.test(cacheControl)) return 0;
  const maxAge = Number(cacheControl.match(EDGE_MAX_AGE)?.[1] ?? 0);
  if (EDGE_CACHEABLE.test(cacheControl) && maxAge > 0) return Math.min(maxAge, 600);
  if (EDGE_RECOMMENDATION_PATHS.test(pathname)) return EDGE_RECOMMENDATION_SECONDS;
  return EDGE_SHARED_PATHS.test(pathname) ? EDGE_DEFAULT_SECONDS : 0;
}

function storedCopy(response, seconds) {
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', `public, max-age=0, s-maxage=${seconds}`);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function edgeCache() {
  return typeof caches === 'undefined' ? null : caches.default;
}

function withEdgeStatus(response, status) {
  const result = observableResponse(response);
  result.headers.set('X-Diva-Edge-Cache', status);
  return result;
}

export async function onRequest({ request, env, waitUntil }) {
  const incoming = new URL(request.url);
  if (!env.PAGES_PROXY_KEY) return configurationError('Pages proxy authentication is not configured');

  const cache = request.method === 'GET' ? edgeCache() : null;
  // URL-only key: cached responses never depend on the caller's headers.
  const cacheKey = cache ? new Request(incoming.toString(), { method: 'GET' }) : null;
  if (cache) {
    const cached = await cache.match(cacheKey).catch(() => undefined);
    if (cached) return withEdgeStatus(cached, 'hit');
  }

  const resolved = await resolveOrigin(env, incoming);
  if (resolved.error) return configurationError(resolved.error);

  const headers = proxyHeaders(request, env, resolved.mode);
  const response = await fetchOrigin(buildTarget(resolved.origin, resolved.mode, incoming), {
    method: request.method,
    headers,
    body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
    redirect: 'manual',
  }, request.signal).catch(() => null);
  if (!response) {
    return observableResponse(Response.json({ error: 'API origin unavailable' }, { status: 502 }));
  }
  const lifetime = cache ? edgeLifetime(incoming.pathname, response) : 0;
  if (lifetime > 0) {
    const stored = cache.put(cacheKey, storedCopy(response.clone(), lifetime)).catch(() => undefined);
    if (typeof waitUntil === 'function') waitUntil(stored);
    return withEdgeStatus(response, 'miss');
  }
  return observableResponse(response);
}
