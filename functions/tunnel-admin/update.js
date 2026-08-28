const QUICK_TUNNEL_PATTERN = /^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/i;
const ORIGIN_KEYS = {
  primary: 'quick_tunnel_primary_url',
  standby: 'quick_tunnel_standby_url',
};

function unauthorized() {
  return Response.json({ error: 'unauthorized' }, { status: 401 });
}

function hexBytes(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/i.test(value)) return null;
  return Uint8Array.from(value.match(/../g), byte => Number.parseInt(byte, 16));
}

async function verifyOriginProof(secret, timestamp, originRole, tunnelUrl, proof, legacy = false) {
  const signature = hexBytes(proof);
  if (!secret || !signature || !Number.isSafeInteger(timestamp)) return false;
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > 300) return false;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  return crypto.subtle.verify(
    'HMAC',
    key,
    signature,
    encoder.encode(legacy
      ? `${timestamp}\n${tunnelUrl}`
      : `${timestamp}\n${originRole}\n${tunnelUrl}`),
  );
}

export async function onRequest({ request, env }) {
  if (request.method !== 'POST') {
    return new Response(null, { status: 405, headers: { allow: 'POST' } });
  }

  const authorization = request.headers.get('authorization');
  if (!env.TUNNEL_SYNC_TOKEN || authorization !== `Bearer ${env.TUNNEL_SYNC_TOKEN}`) return unauthorized();

  if ((env.DIVA_API_ORIGIN_MODE || 'quick').trim().toLowerCase() === 'named') {
    return Response.json({ error: 'quick tunnel synchronization is disabled' }, { status: 410 });
  }
  if (!env.TUNNEL_ORIGIN_PROOF_KEY) {
    return Response.json({ error: 'tunnel origin proof is not configured' }, { status: 503 });
  }
  if (!env.PAGES_PROXY_KEY) {
    return Response.json({ error: 'Pages proxy authentication is not configured' }, { status: 503 });
  }

  const body = await request.json().catch(() => null);
  const tunnelUrl = typeof body?.tunnelUrl === 'string' ? body.tunnelUrl.trim() : '';
  const legacyRequest = body?.originRole == null;
  const originRole = legacyRequest ? 'primary' : body?.originRole;
  if (!Object.hasOwn(ORIGIN_KEYS, originRole)) {
    return Response.json({ error: 'invalid origin role' }, { status: 400 });
  }
  if (!QUICK_TUNNEL_PATTERN.test(tunnelUrl)) {
    return Response.json({ error: 'invalid tunnel URL' }, { status: 400 });
  }
  if (!await verifyOriginProof(
    env.TUNNEL_ORIGIN_PROOF_KEY,
    body?.timestamp,
    originRole,
    tunnelUrl,
    body?.proof,
    legacyRequest,
  )) return unauthorized();

  // Readiness already verifies PostgreSQL, Qdrant aliases/generation, and
  // warmup state from the bounded background snapshot. Avoid the slower
  // operational report here so a cold but healthy deployment can register.
  const health = await fetch(`${tunnelUrl}/backend-api/api/ready`, {
    headers: {
      'x-diva-pages-proxy': '1',
      'x-diva-pages-proxy-key': env.PAGES_PROXY_KEY,
    },
    redirect: 'manual',
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
  if (!health || health.status !== 200) {
    return Response.json({ error: 'tunnel health check failed' }, { status: 424 });
  }
  const healthPayload = await health.json().catch(() => null);
  if (!healthPayload || healthPayload.status !== 'ready') {
    return Response.json({ error: 'tunnel readiness response is invalid' }, { status: 424 });
  }

  const metadata = { checkedAt: new Date().toISOString() };
  await env.TUNNEL_CONFIG.put(ORIGIN_KEYS[originRole], tunnelUrl, { metadata });
  // Preserve the legacy primary key while older deployments and rollback
  // builds may still read it. Standby registration never changes it.
  if (originRole === 'primary') {
    await env.TUNNEL_CONFIG.put('quick_tunnel_url', tunnelUrl, { metadata });
  }
  return Response.json({ success: true, originRole });
}
