const TUNNEL_KEY = 'quick_tunnel_url';
const QUICK_TUNNEL_PATTERN = /^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/i;

export async function onRequest({ request, env }) {
  const tunnelUrl = await env.TUNNEL_CONFIG?.get(TUNNEL_KEY, { cacheTtl: 60 });
  if (!tunnelUrl || !QUICK_TUNNEL_PATTERN.test(tunnelUrl)) {
    return Response.json({ error: 'SBC tunnel is not registered' }, { status: 503 });
  }

  const incoming = new URL(request.url);
  const target = new URL(`${incoming.pathname}${incoming.search}`, `${tunnelUrl}/`);
  const headers = new Headers(request.headers);
  headers.delete('host');
  headers.set('x-diva-pages-proxy', '1');

  return fetch(target, {
    method: request.method,
    headers,
    body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
    redirect: 'manual',
  });
}
