import { readJSON } from '../../../shared/request.js';
// functions/api/admin/checkout-toggle.js — pause / resume checkout kill switch
const json = (o, s = 200) =>
  new Response(JSON.stringify(o), {
    status: s,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

export async function onRequestPost({ request, env, data }) {
  let body;
  try { body = await readJSON(request); } catch (e) { return json({ error: e.message }, e.status || 400); }

  if (typeof body.paused !== 'boolean')
    return json({ error: 'paused must be boolean' }, 400);

  if (body.paused) {
    await env.PRIVATE.put('state/checkout-disabled', 'true', {
      httpMetadata: { contentType: 'text/plain' },
    });
  } else {
    await env.PRIVATE.delete('state/checkout-disabled');
  }

  console.log(JSON.stringify({
    t: new Date().toISOString(), admin: data.admin,
    action: 'checkout_toggle', paused: body.paused,
  }));
  return json({ ok: true, paused: body.paused });
}
