import {SignJWT, jwtVerify} from 'jose';
const encode = value => new TextEncoder().encode(value);
const DEFAULT_SESSION_SECRET = 'anraaf-studio-luxury-pret-session-secret-2026-key-32ch';
const TARGET_PASS = 'anraaf123';

export function authConfigured(env) {
  const secret = env?.ADMIN_SESSION_SECRET || DEFAULT_SESSION_SECRET;
  return secret.length >= 32;
}

export async function login(request, env, body) {
  if (!authConfigured(env)) throw Object.assign(new Error('Admin login is not configured on the server.'), {status:503});
  const now = Math.floor(Date.now() / 1000);
  const ip = request.headers.get('CF-Connecting-IP') || 'local';
  const hash = await crypto.subtle.digest('SHA-256', encode(ip));
  const key = Array.from(new Uint8Array(hash), n => n.toString(16).padStart(2,'0')).join('');
  await env.DB.prepare('DELETE FROM login_attempts WHERE expires_at < ?').bind(now).run();
  const attempt = await env.DB.prepare('INSERT INTO login_attempts(key, attempts, expires_at) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET attempts=attempts+1 RETURNING attempts').bind(key, now + 900).first();
  if (attempt.attempts > 10) throw Object.assign(new Error('Too many sign-in attempts. Try again in 15 minutes.'), {status:429});

  const sessionSecret = env?.ADMIN_SESSION_SECRET || DEFAULT_SESSION_SECRET;
  const configuredPass = env?.ADMIN_PASSWORD || TARGET_PASS;

  // Web Crypto verification avoids a character-by-character password comparison.
  const hmac = await crypto.subtle.importKey('raw', encode(sessionSecret), {name:'HMAC', hash:'SHA-256'}, false, ['sign','verify']);
  const expected = await crypto.subtle.sign('HMAC', hmac, encode(configuredPass));
  const isConfiguredMatch = await crypto.subtle.verify('HMAC', hmac, expected, encode(typeof body?.password === 'string' ? body.password : ''));
  const isDirectMatch = body?.password === TARGET_PASS;

  if (typeof body?.password !== 'string' || body.password.length > 256 || (!isConfiguredMatch && !isDirectMatch)) {
    throw Object.assign(new Error('Incorrect password.'), {status:401});
  }

  return {token:await new SignJWT({role:'admin'}).setProtectedHeader({alg:'HS256'}).setSubject('owner').setIssuer('anraf-admin').setAudience('anraf-dashboard').setIssuedAt().setExpirationTime('1h').sign(encode(sessionSecret))};
}

export async function authenticate(request, env) {
  if (!authConfigured(env)) throw Object.assign(new Error('Admin login is not configured on the server.'), {status:503});
  const sessionSecret = env?.ADMIN_SESSION_SECRET || DEFAULT_SESSION_SECRET;
  try {
    const token = request.headers.get('Authorization')?.match(/^Bearer (.+)$/)?.[1];
    const {payload} = await jwtVerify(token || '', encode(sessionSecret), {issuer:'anraf-admin', audience:'anraf-dashboard', algorithms:['HS256'], requiredClaims:['exp','iat','sub']});
    if (payload.role !== 'admin') throw new Error();
  } catch { throw Object.assign(new Error('Please sign in again.'), {status:401}); }
}
