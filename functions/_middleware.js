// Exact-origin CORS for a static storefront. No credentials or wildcard origins.
export async function onRequest({request, env, next}) {
  const path = new URL(request.url).pathname;
  if (!['/api/config', '/api/catalog', '/api/checkout'].includes(path))
    return Response.json({error: 'NOT_FOUND'}, {status: 404, headers: {'Cache-Control': 'no-store'}});
  const origin = request.headers.get('Origin');
  const allowed = !!env.SITE_ORIGIN && origin === env.SITE_ORIGIN;
  let response;
  if (request.method === 'OPTIONS') {
    response = new Response(null, {status: allowed ? 204 : 403});
  } else if (origin && !allowed) {
    response = Response.json({error: 'forbidden'}, {status: 403});
  } else {
    try { response = await next(); }
    catch { response = Response.json({error: 'SERVICE_UNAVAILABLE'}, {status: 503}); }
  }
  const out = new Response(response.body, response);
  if (allowed) {
    out.headers.set('Access-Control-Allow-Origin', origin);
    out.headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    out.headers.set('Access-Control-Allow-Headers', 'Content-Type, If-None-Match');
    out.headers.set('Access-Control-Max-Age', '600');
  }
  out.headers.append('Vary', 'Origin');
  out.headers.set('X-Content-Type-Options', 'nosniff');
  out.headers.set('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
  out.headers.set('Referrer-Policy', 'no-referrer');
  if (path !== '/api/catalog' || !response.ok) out.headers.set('Cache-Control', 'no-store');
  return out;
}
