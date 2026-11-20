const responseHeaders = {
  'content-type': 'application/json; charset=utf-8',
  'content-security-policy': "sandbox; default-src 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'content-disposition': 'attachment',
  'cache-control': 'no-store',
};

export async function onRequest({ request }) {
  const incoming = new URL(request.url);
  const error = (status, message, headers) => new Response(
    request.method === 'HEAD' ? null : JSON.stringify({ error: message }),
    { status, headers: { ...responseHeaders, ...headers } },
  );
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return error(405, 'method not allowed', { allow: 'GET, HEAD' });
  }

  const match = incoming.pathname.match(
    /^\/invidious-api\/api\/v1\/playlists\/([A-Za-z0-9_-]{8,100})$/,
  );
  if (!match) return error(404, 'unsupported invidious path');

  const rawPage = incoming.searchParams.get('page') ?? '1';
  if (!/^\d+$/.test(rawPage) || Number(rawPage) < 1 || Number(rawPage) > 50) {
    return error(400, 'page must be between 1 and 50');
  }

  const target = new URL(`/api/v1/playlists/${match[1]}?page=${Number(rawPage)}`, 'https://inv.nadeko.net/');
  let upstream;
  try {
    upstream = await fetch(target, {
      method: request.method,
      headers: { accept: 'application/json' },
      redirect: 'manual',
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(15_000)]),
    });
  } catch {
    return error(502, 'playlist upstream unavailable');
  }
  const mediaType = upstream.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
  if (upstream.status !== 200 || mediaType !== 'application/json') {
    await upstream.body?.cancel().catch(() => {});
    const status = upstream.status >= 400 && upstream.status <= 599 ? upstream.status : 502;
    return error(status, 'invalid playlist upstream response');
  }

  // Build new response headers so the external origin cannot set cookies or control this origin.
  return new Response(request.method === 'HEAD' ? null : upstream.body, { headers: responseHeaders });
}
