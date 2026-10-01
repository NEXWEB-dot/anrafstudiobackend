// functions/api/admin/orders/[id].js — PATCH order status
import { rpc, BackendError, isAvailabilityError } from '../../../../shared/sb.js';
import { getMode } from '../../../../shared/mode.js';

const json = (o, s = 200) =>
  new Response(JSON.stringify(o), {
    status: s,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VALID_STATUSES = new Set(['pending', 'confirmed', 'shipped', 'delivered', 'cancelled']);

export async function onRequestPatch({ request, env, params, data }) {
  const id = params.id;
  if (!UUID.test(id)) return json({ error: 'invalid_id' }, 400);

  const mode = await getMode(env);
  if (mode.mode === 'emergency')
    return json({
      error: 'EMERGENCY_MODE',
      message: 'Order status changes unavailable while database is offline.',
    }, 409);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'bad_json' }, 400); }

  const status = String(body.status ?? '');
  if (!VALID_STATUSES.has(status)) return json({ error: 'invalid_status' }, 400);

  try {
    const result = await (await rpc(env, 'set_order_status', {
      p_order_id: id, p_status: status,
    })).json();
    console.log(JSON.stringify({
      t: new Date().toISOString(), admin: data.admin,
      action: 'set_order_status', target: id, status,
    }));
    return json(result);
  } catch (e) {
    if (e instanceof BackendError) {
      if (isAvailabilityError(e)) return json({ error: 'database_unavailable' }, 503);
      let m = {}; try { m = JSON.parse(e.body); } catch {}
      if ((m.message ?? '').includes('NOT_FOUND')) return json({ error: 'not_found' }, 404);
      if ((m.message ?? '').includes('BAD_TRANSITION')) return json({ error: 'invalid_transition' }, 409);
    }
    return json({ error: 'server_error' }, 500);
  }
}
