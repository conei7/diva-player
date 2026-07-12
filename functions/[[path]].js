export async function onRequest({ request, env }) {
  const indexUrl = new URL('/index.html', request.url);
  return env.ASSETS.fetch(new Request(indexUrl, {
    method: 'GET',
    headers: request.headers,
  }));
}
