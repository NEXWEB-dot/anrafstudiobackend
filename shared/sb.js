// shared/sb.js — the ONLY door to Supabase. All server code imports from here.
// Uses raw fetch against PostgREST (not supabase-js) so HTTP status codes are
// visible and every call has a hard timeout.

export class BackendError extends Error {
  constructor(msg, status, body) {
    super(msg);
    this.status = status;
    this.body = body;
  }
}

// "Supabase is unavailable" (as opposed to "your request was invalid"):
// network/timeout (0), auth issues (401/403), quota (402), rate limit (429), any 5xx, Cloudflare edge errors
const AVAILABILITY = new Set([
  0, 401, 403, 402, 408, 429,
  500, 502, 503, 504,
  520, 521, 522, 523, 524, 525, 526, 530, 540,
]);
export const isAvailabilityError = (e) =>
  e instanceof BackendError && AVAILABILITY.has(e.status);

/**
 * Make a request to the Supabase REST API.
 * A 401/403 is treated as an availability error on purpose:
 * a mis-rotated key must degrade to Emergency Mode, not take the store down.
 */
export async function sb(env, path, { method = 'GET', body, headers = {}, timeout = 4000 } = {}) {
  const key = env.SUPABASE_SERVICE_KEY;
  const h = { apikey: key, 'Content-Type': 'application/json', ...headers };
  // Legacy JWT keys (eyJ…) need Authorization header; new sb_secret_… keys don't
  if (key.startsWith('eyJ')) h.Authorization = `Bearer ${key}`;

  let res;
  try {
    res = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
      method,
      headers: h,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    });
  } catch {
    throw new BackendError('network/timeout', 0);
  }

  if (!res.ok)
    throw new BackendError(
      `supabase ${res.status}`,
      res.status,
      await res.text().catch(() => '')
    );

  return res; // caller decides: .text() (pipe) or .json()
}

export const rpc = (env, fn, args = {}, opts) =>
  sb(env, `rpc/${fn}`, { method: 'POST', body: args, ...opts });
