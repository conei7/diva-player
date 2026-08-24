const BROWSER_SECURITY_HEADERS = {
  'content-security-policy': "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self' https://www.youtube.com https://s.ytimg.com https://w.soundcloud.com; script-src-attr 'none'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' data: https://fonts.gstatic.com; img-src 'self' data: blob: https:; media-src 'self' blob: https:; connect-src 'self' https://vocadb.net https://*.vocadb.net; frame-src https://www.youtube.com https://www.youtube-nocookie.com https://embed.nicovideo.jp https://w.soundcloud.com https://player.bilibili.com; worker-src 'self' blob:; manifest-src 'self'",
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
};

export async function onRequest({ request, env }) {
  const indexUrl = new URL('/index.html', request.url);
  const response = await env.ASSETS.fetch(new Request(indexUrl, {
    method: 'GET',
    headers: request.headers,
  }));
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(BROWSER_SECURITY_HEADERS)) headers.set(name, value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
