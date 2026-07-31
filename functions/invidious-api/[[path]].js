export async function onRequest({ request }) {
  const incoming = new URL(request.url);
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response(null, { status: 405, headers: { allow: 'GET, HEAD' } });
  }

  const match = incoming.pathname.match(
    /^\/invidious-api\/api\/v1\/playlists\/([A-Za-z0-9_-]{8,100})$/,
  );
  if (!match) return Response.json({ error: 'unsupported invidious path' }, { status: 404 });

  const rawPage = incoming.searchParams.get('page') ?? '1';
  if (!/^\d+$/.test(rawPage) || Number(rawPage) < 1 || Number(rawPage) > 50) {
    return Response.json({ error: 'page must be between 1 and 50' }, { status: 400 });
  }

  const target = new URL(`/api/v1/playlists/${match[1]}?page=${rawPage}`, 'https://inv.nadeko.net/');
  const headers = new Headers();
  const accept = request.headers.get('accept');
  if (accept) headers.set('accept', accept);

  return fetch(target, {
    method: request.method,
    headers,
    body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
    redirect: 'manual',
  });
}
