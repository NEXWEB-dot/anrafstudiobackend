// functions/api/admin/status.js
// Returns the current system state for the dashboard status banner.
// Reads from R2 only — works in every mode including when Supabase is down.
import { getMode } from '../../../shared/mode.js';

const json = (o) =>
  new Response(JSON.stringify(o), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

export async function onRequestGet({ env }) {
  const [mode, syncObj, opsObj, ordersResult, checkoutDisabled] = await Promise.all([
    getMode(env),
    env.PRIVATE.get('state/sync.json'),
    env.PRIVATE.get('state/pending-ops.json'),
    env.PRIVATE.list({ prefix: 'orders-pending/', limit: 100 }),
    env.PRIVATE.head('state/checkout-disabled'),
  ]);

  const sync = syncObj ? await syncObj.json() : null;
  const opsData = opsObj ? await opsObj.json() : null;
  const pendingOps = opsData?.ops?.length ?? 0;
  const pendingOrders = ordersResult.objects.length;

  // Get catalog generated_at from the public file for display
  let catalogGeneratedAt = null;
  try {
    const catObj = await env.PUBLIC.get('catalog/products.json');
    if (catObj) {
      const text = await catObj.text();
      const m = /"generated_at"\s*:\s*"([^"]+)"/.exec(text);
      if (m) catalogGeneratedAt = m[1];
    }
  } catch {}

  return json({
    mode: mode.mode,
    reason: mode.reason ?? null,
    since: mode.since ?? null,
    pendingOps,
    pendingOrders,
    lastSync: sync
      ? { ok: sync.ok, ts: sync.ts, count: sync.count, error: sync.error ?? null }
      : null,
    checkoutPaused: !!checkoutDisabled,
    catalogGeneratedAt,
  });
}
