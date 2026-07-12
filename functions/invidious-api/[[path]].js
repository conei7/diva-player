export async function onRequest({ request }) {
  const incoming = new URL(request.url);
  const apiPath = incoming.pathname.replace(/^\/invidious-api/, '') || '/';
  const target = new URL(`${apiPath}${incoming.search}`, 'https://inv.nadeko.net/');
  const headers = new Headers(request.headers);
  headers.delete('host');

  return fetch(target, {
    method: request.method,
    headers,
    body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
    redirect: 'manual',
  });
}
