// shared/mode.js — circuit breaker + Emergency Mode state in R2
// State lives in R2 (PRIVATE:state/mode.json) so all Functions and the cron
// Worker see the same state.

import { alertOnce } from './alerts.js';

const KEY = 'state/mode.json';
const TRIP_MS = 5 * 60_000; // 5 minutes

export async function getMode(env) {
  const o = await env.PRIVATE.get(KEY);
  return o ? o.json() : { mode: 'normal' };
}

export const tripped = (s) => s.mode === 'emergency' && Date.now() < s.until;

/**
 * Writes must go through Emergency Mode while:
 * 1. The breaker is tripped (Supabase is down), OR
 * 2. There are un-replayed ops in the queue
 *
 * Mixing normal and emergency writes would corrupt the replay queue.
 */
export async function mustUseEmergency(env) {
  if (tripped(await getMode(env))) return true;
  const q = await env.PRIVATE.get('state/pending-ops.json');
  if (!q) return false;
  return ((await q.json()).ops ?? []).length > 0;
}

export async function tripBreaker(env, reason) {
  const prev = await getMode(env);
  await env.PRIVATE.put(KEY, JSON.stringify({
    mode: 'emergency',
    reason,
    since: prev.mode === 'emergency' ? prev.since : Date.now(),
    until: Date.now() + TRIP_MS,
  }));
  // Alert only on the first trip (not on every re-trip while still down)
  if (prev.mode !== 'emergency') {
    await alertOnce(
      env,
      'emergency-entered',
      `Supabase unavailable (${reason}). Store is serving from R2; dashboard is in Emergency Mode.`
    );
  }
}

export const clearBreaker = (env) =>
  env.PRIVATE.put(KEY, JSON.stringify({ mode: 'normal', since: Date.now() }));
