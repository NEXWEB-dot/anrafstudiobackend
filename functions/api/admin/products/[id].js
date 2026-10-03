import { readJSON } from '../../../../shared/request.js';
// functions/api/admin/products/[id].js — PUT (update) and DELETE
import { saveProduct, deleteProduct, ValidationError } from '../_product-ops.js';

const json = (o, s = 200) =>
  new Response(JSON.stringify(o), {
    status: s,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function onRequestPut({ request, env, params, data }) {
  const id = params.id;
  if (!UUID.test(id)) return json({ error: 'invalid_id' }, 400);

  let body;
  try { body = await readJSON(request); } catch (e) { return json({ error: e.message }, e.status || 400); }

  try {
    body.id = id; // URL param id always wins
    const result = await saveProduct(env, body);
    console.log(JSON.stringify({
      t: new Date().toISOString(), admin: data.admin,
      action: 'update_product', target: id,
    }));
    return json(result);
  } catch (e) {
    if (e instanceof ValidationError) return json({ error: e.message }, 400);
    console.error('update_product error:', e);
    return json({ error: 'server_error' }, 500);
  }
}

export async function onRequestDelete({ request, env, params, data }) {
  const id = params.id;
  if (!UUID.test(id)) return json({ error: 'invalid_id' }, 400);

  const url = new URL(request.url);
  const confirmShrink = url.searchParams.get('confirmShrink') === 'true';

  try {
    const result = await deleteProduct(env, id, { confirmShrink });
    console.log(JSON.stringify({
      t: new Date().toISOString(), admin: data.admin,
      action: 'delete_product', target: id,
    }));
    return json(result);
  } catch (e) {
    console.error('delete_product error:', e);
    return json({ error: 'server_error' }, 500);
  }
}
