// Only public configuration is exposed. Never return bindings or secrets.
export function onRequestGet({ env }) {
  return Response.json({ turnstileSiteKey: env.TURNSTILE_SITE_KEY || '' }, {
    headers: { 'Cache-Control': 'no-store' },
  });
}
