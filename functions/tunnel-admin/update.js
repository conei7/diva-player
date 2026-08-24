const QUICK_TUNNEL_PATTERN = /^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/i;

function unauthorized() {
  return Response.json({ error: 'unauthorized' }, { status: 401 });
}

function hexBytes(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/i.test(value)) return null;
  return Uint8Array.from(value.match(/../g), byte => Number.parseInt(byte, 16));
}

async function verifyOriginProof(secret, timestamp, tunnelUrl, proof) {
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
    encoder.encode(`${timestamp}\n${tunnelUrl}`),
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
  if (!QUICK_TUNNEL_PATTERN.test(tunnelUrl)) {
    return Response.json({ error: 'invalid tunnel URL' }, { status: 400 });
  }
  if (!await verifyOriginProof(
    env.TUNNEL_ORIGIN_PROOF_KEY,
    body?.timestamp,
    tunnelUrl,
    body?.proof,
  )) return unauthorized();

  // Readiness already verifies PostgreSQL, Qdrant aliases/generation, and
  // warmup state from the bounded background snapshot. Avoid the slower
  // operational report here so a cold but healthy deployment can register.
  const health = await fetch(`${tunnelUrl}/backend-api/api/ready`, {
    headers: {
      'x-diva-pages-proxy': '1',
      'x-diva-pages-proxy-key': env.PAGES_PROXY_KEY,
    },
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
  if (!health?.ok) return Response.json({ error: 'tunnel health check failed' }, { status: 424 });

  await env.TUNNEL_CONFIG.put('quick_tunnel_url', tunnelUrl);
  return Response.json({ success: true });
}
