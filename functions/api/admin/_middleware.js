// functions/api/admin/_middleware.js
// Protects ALL /api/admin/* routes with:
// 1. Cloudflare Access JWT verification
// 2. Email allowlist check
// 3. Origin check (CSRF defense) on non-GET requests
import { createRemoteJWKSet, jwtVerify } from 'jose';

let JWKS; // cached across invocations in the same isolate

export async function onRequest({ request, env, data, next }) {
  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!token) return new Response('Unauthorized', { status: 401 });

  try {
    JWKS ??= createRemoteJWKSet(
      new URL(`https://${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`)
    );
    const { payload } = await jwtVerify(token, JWKS, {
      issuer: `https://${env.ACCESS_TEAM_DOMAIN}`,
      audience: env.ACCESS_AUD,
    });

    const allow = env.ADMIN_EMAILS.split(',').map((s) => s.trim().toLowerCase());
    if (!allow.includes(String(payload.email ?? '').toLowerCase()))
      return new Response('Forbidden', { status: 403 });

    // Attach email to request data for audit logging
    data.admin = payload.email;
  } catch {
    return new Response('Unauthorized', { status: 401 });
  }

  // CSRF: Origin check on all mutating requests
  if (
    !['GET', 'HEAD'].includes(request.method) &&
    request.headers.get('Origin') !== env.SITE_ORIGIN
  )
    return new Response('Bad origin', { status: 403 });

  const res = await next();
  // next()'s headers may be immutable — clone to add Cache-Control
  const out = new Response(res.body, res);
  out.headers.set('Cache-Control', 'no-store');
  return out;
}
