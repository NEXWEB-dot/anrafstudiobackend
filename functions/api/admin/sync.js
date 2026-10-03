import { readJSON } from '../../../shared/request.js';
import { mustUseEmergency } from '../../../shared/mode.js';
// functions/api/admin/sync.js — manual "Sync storefront now" button
import { syncCatalog, SyncRejected, recordSyncFailure } from '../../../shared/catalog.js';

const json = (o, s = 200) =>
  new Response(JSON.stringify(o), {
    status: s,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

export async function onRequestPost({ request, env, data }) {
  if (await mustUseEmergency(env)) return json({ error: 'Pending recovery must complete before syncing.' }, 409);
  let body = {};
  try { body = await readJSON(request); } catch (e) { return json({ error: e.message }, e.status || 400); }

  const confirmShrink = body.confirmShrink === true;

  try {
    const { count } = await syncCatalog(env, { allowShrink: confirmShrink });
    console.log(JSON.stringify({
      t: new Date().toISOString(), admin: data.admin,
      action: 'manual_sync', count,
    }));
    return json({ ok: true, count });
  } catch (e) {
    if (e instanceof SyncRejected) {
      await recordSyncFailure(env, e);
      return json({ ok: false, reason: e.message, canForce: true }, 409);
    }
    await recordSyncFailure(env, e);
    return json({ ok: false, reason: String(e) }, 500);
  }
}
