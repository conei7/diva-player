const LEGACY_TUNNEL_KEY = 'quick_tunnel_url';
const PRIMARY_TUNNEL_KEY = 'quick_tunnel_primary_url';
const STANDBY_TUNNEL_KEY = 'quick_tunnel_standby_url';
const QUICK_TUNNEL_PATTERN = /^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/i;

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

async function resolveOrigin(env, incoming) {
  const mode = (env.DIVA_API_ORIGIN_MODE || 'quick').trim().toLowerCase();
  if (mode === 'named') {
    const origin = parseNamedOrigin(env.DIVA_NAMED_TUNNEL_ORIGIN, incoming.hostname);
    if (!origin) return { error: 'named tunnel origin is not configured safely' };
    if (!env.CF_ACCESS_CLIENT_ID || !env.CF_ACCESS_CLIENT_SECRET) {
      return { error: 'named tunnel access credentials are not configured' };
    }
    return { mode, origins: [origin] };
  }

  if (mode !== 'quick') return { error: 'unsupported API origin mode' };
  const [configuredPrimary, legacyPrimary, configuredStandby] = await Promise.all([
    env.TUNNEL_CONFIG?.get(PRIMARY_TUNNEL_KEY, { cacheTtl: 60 }),
    env.TUNNEL_CONFIG?.get(LEGACY_TUNNEL_KEY, { cacheTtl: 60 }),
    env.TUNNEL_CONFIG?.get(STANDBY_TUNNEL_KEY, { cacheTtl: 60 }),
  ]);
  const primary = configuredPrimary || legacyPrimary;
  if (!primary || !QUICK_TUNNEL_PATTERN.test(primary)) {
    return { error: 'SBC tunnel is not registered' };
  }
  const origins = [primary];
  if (configuredStandby
      && QUICK_TUNNEL_PATTERN.test(configuredStandby)
      && configuredStandby !== primary) {
    origins.push(configuredStandby);
  }
  return { mode, origins };
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

export async function onRequest({ request, env }) {
  const incoming = new URL(request.url);
  if (!env.PAGES_PROXY_KEY) return configurationError('Pages proxy authentication is not configured');

  const resolved = await resolveOrigin(env, incoming);
  if (resolved.error) return configurationError(resolved.error);

  const headers = proxyHeaders(request, env, resolved.mode);
  const canRetryBody = request.method !== 'GET' && request.method !== 'HEAD'
    && resolved.origins.length > 1;
  const fallbackRequest = canRetryBody ? request.clone() : null;
  const firstResponse = await fetch(buildTarget(resolved.origins[0], resolved.mode, incoming), {
    method: request.method,
    headers,
    body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
    redirect: 'manual',
    signal: request.signal,
  }).catch(() => null);

  if (resolved.origins.length === 1
      || (firstResponse && firstResponse.status < 500)) {
    return firstResponse ?? Response.json({ error: 'API origin unavailable' }, { status: 502 });
  }

  await firstResponse?.body?.cancel().catch(() => {});

  const fallbackResponse = await fetch(
    buildTarget(resolved.origins[1], resolved.mode, incoming),
    {
      method: request.method,
      headers,
      body: request.method === 'GET' || request.method === 'HEAD'
        ? undefined
        : fallbackRequest?.body,
      redirect: 'manual',
      signal: request.signal,
    },
  ).catch(() => null);
  return fallbackResponse
    ?? Response.json({ error: 'API origins unavailable' }, { status: 502 });
}
