// functions/api/checkout.js
// The ONLY public dynamic endpoint. Boringly defensive.
import { rpc, BackendError, isAvailabilityError } from '../../shared/sb.js';
import { mustUseEmergency, tripBreaker } from '../../shared/mode.js';
import { sendMail, esc, alertOnce } from '../../shared/alerts.js';
import { readJSON } from '../../shared/request.js';

const json = (o, status = 200) =>
  new Response(JSON.stringify(o), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PHONE = /^\+?[0-9][0-9\s\-]{6,18}$/;

export async function onRequestPost({ request, env, waitUntil }) {
  // Security: reject wrong origin immediately
  if (request.headers.get('Origin') !== env.SITE_ORIGIN)
    return json({ error: 'forbidden' }, 403);

  // Kill switch: admin can pause checkout from the dashboard
  if (await env.PRIVATE.head('state/checkout-disabled'))
    return json({ error: 'CHECKOUT_PAUSED', whatsapp: env.WHATSAPP_URL }, 503);

  // Content-type check
  const ct = request.headers.get('Content-Type') ?? '';
  if (ct.split(';')[0].trim().toLowerCase() !== 'application/json')
    return json({ error: 'bad_content_type' }, 400);

  // Body size cap (20 KB)
  let b;
  try { b = await readJSON(request); } catch (e) { return json({ error: e.message }, e.status || 400); }

  // Honeypot: pretend success but do nothing (never write to DB)
  if (b.hp) return json({ error: 'BAD_INPUT' }, 400);

  if (!env.TURNSTILE_SECRET || typeof b.turnstile_token !== 'string' ||
      !b.turnstile_token || b.turnstile_token.length > 2048)
    return json({ error: 'BOT_CHECK_FAILED' }, 403);

  // 1) Turnstile verification (server-side, mandatory)
  const ts = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    signal: AbortSignal.timeout(8000),
    body: new URLSearchParams({
      secret: env.TURNSTILE_SECRET,
      response: String(b.turnstile_token ?? ''),
      // remoteip is optional; cross-zone Worker proxies do not retain the shopper's IP.
    }),
  }).then((r) => r.json()).catch(() => ({ success: false }));

  if (!ts.success || ts.hostname !== new URL(env.SITE_ORIGIN).hostname)
    return json({ error: 'BOT_CHECK_FAILED' }, 403);

  // 2) Validate + normalise everything. NEVER trust client prices.
  const name = String(b.name ?? '').trim();
  const phone = String(b.phone ?? '').trim();
  const address = String(b.address ?? '').trim();
  const notes = String(b.notes ?? '').trim();
  const ref = String(b.client_ref ?? '');
  const items = Array.isArray(b.items)
    ? b.items.map((i) => ({
        product_id: i?.product_id,
        qty: i?.qty,
        size: i?.size ?? 'Small',
      }))
    : [];

  if (
    ['name', 'phone', 'address'].some(key => typeof b[key] !== 'string') ||
    (b.notes != null && typeof b.notes !== 'string') ||
    !UUID.test(ref) ||
    name.length < 1 || name.length > 100 ||
    !PHONE.test(phone) ||
    !address || address.length > 500 || notes.length > 500 ||
    !items.length || items.length > 30 ||
    new Set(items.map(i => `${i.product_id}:${i.size}`)).size !== items.length ||
    items.some(
      (i) =>
        !UUID.test(i.product_id) ||
        !Number.isInteger(i.qty) ||
        i.qty < 1 ||
        i.qty > 20 || !['Small', 'Medium', 'Large', 'XL'].includes(i.size)
    )
  )
    return json({ error: 'BAD_INPUT' }, 400);

  const args = {
    p_client_ref: ref,
    p_name: name,
    p_phone: phone,
    p_address: address,
    p_notes: notes,
    p_items: items,
    p_force: false,
  };

  // 3) Save: Supabase first, R2 offline capture if unavailable
  let result = null;
  if (!(await mustUseEmergency(env))) {
    try {
      result = await (await rpc(env, 'place_order', args)).json();
    } catch (e) {
      if (!(e instanceof BackendError)) throw e;
      if (isAvailabilityError(e)) {
        await tripBreaker(env, `checkout ${e.status}`);
        // fall through to offline capture
      } else if (/23505/.test(e.body ?? '')) {
        // Unique constraint on client_ref = double submit → return the existing order
        result = await (await rpc(env, 'place_order', args)).json();
      } else {
        return mapOrderError(e); // OUT_OF_STOCK, PRODUCT_UNAVAILABLE, BAD_INPUT
      }
    }
  }

  if (!result) {
    result = await saveOffline(env, args);
    if (result.error) return json({ error: result.error }, 409);
  }

  // Send admin email in the background — never blocks the customer response
  if (!result.duplicate) waitUntil(notifyAdmin(env, args, result));

  return json({
    ok: true,
    ref,
    order_number: result.order_number ?? null,
    total: result.total,
    offline: !!result.offline,
  });
}

function mapOrderError(e) {
  let m = {};
  try { m = JSON.parse(e.body); } catch {}
  const code = ['OUT_OF_STOCK', 'PRODUCT_UNAVAILABLE', 'BAD_INPUT'].find((c) =>
    (m.message ?? '').includes(c)
  );
  if (code)
    return json(
      { error: code, detail: m.details ?? null },
      code === 'BAD_INPUT' ? 400 : 409
    );
  return json({ error: 'ORDER_FAILED' }, 502);
}

/** Capture the order in R2 when Supabase is unavailable. */
async function saveOffline(env, a) {
  const key = `orders-pending/${a.p_client_ref}.json`;
  const existing = await env.PRIVATE.get(key); // idempotent
  if (existing) {
    const o = await existing.json();
    return { offline: true, total: o.total, duplicate: true };
  }

  // Prices come from the catalog we control (R2), NOT from the client
  const catObj = await env.PUBLIC.get('catalog/products.json');
  const cat = catObj ? await catObj.json() : null;
  const byId = new Map((cat?.products ?? []).map((p) => [p.id, p]));

  let total = 0;
  const lines = [];
  for (const it of a.p_items) {
    const p = byId.get(it.product_id);
    if (!p || !p.in_stock || p.is_active === false || !Number.isFinite(Number(p.price)) || Number(p.price) < 0)
      return { error: 'PRODUCT_UNAVAILABLE' };
    lines.push({ product_id: p.id, name: p.name, price: Number(p.price), qty: it.qty, size: it.size });
    total += Number(p.price) * it.qty;
  }

  const saved = await env.PRIVATE.put(
    key,
    JSON.stringify({
      client_ref: a.p_client_ref,
      created_at: new Date().toISOString(),
      name: a.p_name,
      phone: a.p_phone,
      address: a.p_address,
      notes: a.p_notes,
      items: lines,
      total,
    }),
    { onlyIf: { etagDoesNotMatch: '*' } }
  );
  if (!saved) {
    const existingOrder = await env.PRIVATE.get(key);
    if (!existingOrder) throw new Error('Order capture conflict');
    return { offline: true, total: (await existingOrder.json()).total, duplicate: true };
  }
  return { offline: true, total };
}

/** Email the admin about a new order. Escaped, never throws into the request. */
async function notifyAdmin(env, args, result) {
  try {
    const isOffline = !!result.offline;
    const prefix = isOffline ? '[OFFLINE – will sync automatically] ' : '';
    const orderRef = result.order_number ? `#${result.order_number}` : args.p_client_ref.slice(0, 8);

    // Build items table from the catalog (for offline) or from the order result
    const catObj = await env.PUBLIC.get('catalog/products.json');
    const cat = catObj ? await catObj.json() : null;
    const byId = new Map((cat?.products ?? []).map((p) => [p.id, p]));

    const rows = args.p_items
      .map((it) => {
        const p = byId.get(it.product_id);
        return `<tr>
          <td>${esc(p?.name ?? it.product_id)} (${esc(it.size)})</td>
          <td>${esc(String(it.qty))}</td>
          <td>PKR ${esc(String(p?.price ?? '?'))}</td>
        </tr>`;
      })
      .join('');

    const html = `
      <h2>${esc(prefix)}New Order ${esc(orderRef)}</h2>
      <p><strong>Customer:</strong> ${esc(args.p_name)}</p>
      <p><strong>Phone:</strong> ${esc(args.p_phone)}</p>
      <p><strong>Address:</strong> ${esc(args.p_address)}</p>
      ${args.p_notes ? `<p><strong>Notes:</strong> ${esc(args.p_notes)}</p>` : ''}
      <table border="1" cellpadding="6" cellspacing="0">
        <thead><tr><th>Product</th><th>Qty</th><th>Price</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <p><strong>Total: PKR ${esc(String(result.total))}</strong></p>
      ${isOffline ? '<p><em>⚠️ Captured offline — database was unavailable. Will sync automatically.</em></p>' : ''}
    `;

    await sendMail(env, {
      to: env.ADMIN_NOTIFY_EMAIL,
      subject: `${prefix}New Order ${orderRef} — ${esc(args.p_name)}`,
      html,
    });
  } catch (e) {
    await alertOnce(env, 'order-email-failed', `Failed to send order email: ${e}`);
  }
}
