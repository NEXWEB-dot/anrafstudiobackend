import { readJSON } from '../../../shared/request.js';
// functions/api/admin/products.js — GET (list) and POST (create)
import { saveProduct, ValidationError } from './_product-ops.js';

const json = (o, s = 200) =>
  new Response(JSON.stringify(o), {
    status: s,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

/** GET /api/admin/products — serves admin snapshot from R2 (works in every mode) */
export async function onRequestGet({ env }) {
  const o = await env.PRIVATE.get('catalog/admin-products.json');
  if (!o) return json({ count: 0, version: 1, generated_at: new Date(0).toISOString(), products: [] });
  const text = await o.text();
  return new Response(text, {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

/** POST /api/admin/products — create a new product */
export async function onRequestPost({ request, env, data }) {
  let body;
  try { body = await readJSON(request); } catch (e) { return json({ error: e.message }, e.status || 400); }

  try {
    body.id = crypto.randomUUID(); // server assigns the ID
    const result = await saveProduct(env, body);
    console.log(JSON.stringify({
      t: new Date().toISOString(), admin: data.admin,
      action: 'create_product', target: body.id,
    }));
    return json(result);
  } catch (e) {
    if (e instanceof ValidationError) return json({ error: e.message }, 400);
    console.error('create_product error:', e);
    return json({ error: 'server_error' }, 500);
  }
}
