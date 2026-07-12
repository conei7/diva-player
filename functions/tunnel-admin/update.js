const QUICK_TUNNEL_PATTERN = /^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/i;

function unauthorized() {
  return Response.json({ error: 'unauthorized' }, { status: 401 });
}

export async function onRequest({ request, env }) {
  if (request.method !== 'POST') {
    return new Response(null, { status: 405, headers: { allow: 'POST' } });
  }

  const authorization = request.headers.get('authorization');
  if (!env.TUNNEL_SYNC_TOKEN || authorization !== `Bearer ${env.TUNNEL_SYNC_TOKEN}`) return unauthorized();

  const body = await request.json().catch(() => null);
  const tunnelUrl = typeof body?.tunnelUrl === 'string' ? body.tunnelUrl.trim() : '';
  if (!QUICK_TUNNEL_PATTERN.test(tunnelUrl)) {
    return Response.json({ error: 'invalid tunnel URL' }, { status: 400 });
  }

  const health = await fetch(`${tunnelUrl}/backend-api/api/health`, {
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
  if (!health?.ok) return Response.json({ error: 'tunnel health check failed' }, { status: 424 });

  await env.TUNNEL_CONFIG.put('quick_tunnel_url', tunnelUrl);
  return Response.json({ success: true });
}
