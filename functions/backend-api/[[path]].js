const TUNNEL_KEY = 'quick_tunnel_url';
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
    return { mode, origin };
  }

  if (mode !== 'quick') return { error: 'unsupported API origin mode' };
  const tunnelUrl = await env.TUNNEL_CONFIG?.get(TUNNEL_KEY, { cacheTtl: 60 });
  if (!tunnelUrl || !QUICK_TUNNEL_PATTERN.test(tunnelUrl)) {
    return { error: 'SBC tunnel is not registered' };
  }
  return { mode, origin: tunnelUrl };
}

export async function onRequest({ request, env }) {
  const incoming = new URL(request.url);
  if (!env.PAGES_PROXY_KEY) return configurationError('Pages proxy authentication is not configured');

  const resolved = await resolveOrigin(env, incoming);
  if (resolved.error) return configurationError(resolved.error);

  // Quick Tunnel terminates at the Web container, whose nginx removes the
  // /backend-api prefix. The named tunnel terminates directly at HAProxy, so
  // remove that prefix here and expose only the API gateway at the origin.
  const upstreamPath = resolved.mode === 'named'
    ? incoming.pathname.replace(/^\/backend-api(?=\/|$)/, '') || '/'
    : incoming.pathname;
  // Assign the path on the validated origin. A path beginning with "//"
  // passed to the URL constructor is interpreted as a scheme-relative host,
  // which could otherwise leak the proxy credentials to another origin.
  const target = new URL(resolved.origin);
  target.pathname = upstreamPath;
  target.search = incoming.search;
  const headers = new Headers(request.headers);
  headers.delete('host');
  // Do not forward client-controlled identity headers. Cloudflare sets
  // cf-connecting-ip at the edge; the API uses this value for rate limiting.
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
  if (resolved.mode === 'named') {
    headers.set('cf-access-client-id', env.CF_ACCESS_CLIENT_ID);
    headers.set('cf-access-client-secret', env.CF_ACCESS_CLIENT_SECRET);
  }

  return fetch(target, {
    method: request.method,
    headers,
    body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
    redirect: 'manual',
    signal: request.signal,
  });
}
