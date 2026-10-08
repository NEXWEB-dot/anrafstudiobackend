// Email-only checkout: server-priced Sanity products, Turnstile, then Resend.
// No database, R2 binding, public customer documents or browser API secrets.
import {readJSON} from '../../shared/request.js';
import {getSanityCatalog, PRODUCT_ID} from '../../shared/sanity.js';

const json = (body, status = 200) => Response.json(body, {status, headers: {
  'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
}});
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

export async function onRequestPost({request, env}) {
  if (!env.SITE_ORIGIN || request.headers.get('Origin') !== env.SITE_ORIGIN)
    return json({error:'forbidden'},403);
  if (env.CHECKOUT_ENABLED !== 'true' || !env.RESEND_API_KEY || !env.MAIL_FROM || !env.ADMIN_NOTIFY_EMAIL || !env.TURNSTILE_SECRET)
    return json({error:'CHECKOUT_PAUSED'},503);
  if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json')
    return json({error:'bad_content_type'},400);
  let b;
  try { b = await readJSON(request); } catch (e) { return json({error:e.message},e.status || 400); }
  if (b.hp) return json({error:'BAD_INPUT'},400);
  if (typeof b.turnstile_token !== 'string' || !b.turnstile_token || b.turnstile_token.length > 2048)
    return json({error:'BOT_CHECK_FAILED'},403);
  if (typeof b.client_ref !== 'string' || !UUID.test(b.client_ref) ||
      typeof b.name !== 'string' || !b.name.trim() || b.name.length > 100 ||
      typeof b.phone !== 'string' || !/^\+923\d{9}$/.test(b.phone) ||
      typeof b.address !== 'string' || !b.address.trim() || b.address.length > 500 ||
      (b.notes != null && (typeof b.notes !== 'string' || b.notes.length > 500)) ||
      !Array.isArray(b.items) || !b.items.length || b.items.length > 30 ||
      b.items.some(i => !i || typeof i.product_id !== 'string' || !PRODUCT_ID.test(i.product_id) ||
        !Number.isInteger(i.qty) || i.qty < 1 || i.qty > 20 || !['Small','Medium','Large','XL'].includes(i.size)) ||
      new Set(b.items.map(i => `${i.product_id}:${i.size}`)).size !== b.items.length)
    return json({error:'BAD_INPUT'},400);

  let verified;
  try {
    const result = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method:'POST', signal:AbortSignal.timeout(8000),
      body:new URLSearchParams({secret:env.TURNSTILE_SECRET,response:b.turnstile_token,idempotency_key:b.client_ref}),
    });
    verified = result.ok && await result.json();
    if (!verified?.success || verified.hostname !== new URL(env.SITE_ORIGIN).hostname)
      return json({error:'BOT_CHECK_FAILED'},403);
  } catch { return json({error:'BOT_CHECK_FAILED'},403); }

  let catalog;
  try { catalog = await getSanityCatalog(env,{checkout:true}); }
  catch { return json({error:'CATALOG_UNAVAILABLE'},503); }
  const products = new Map(catalog.products.map(p => [p.id,p]));
  const lines = [];
  let cents = 0;
  for (const item of b.items) {
    const p = products.get(item.product_id);
    if (!p) return json({error:'PRODUCT_UNAVAILABLE'},409);
    if (!p.in_stock) return json({error:'OUT_OF_STOCK'},409);
    if (!p.sizes.includes(item.size)) return json({error:'SIZE_UNAVAILABLE'},409);
    const lineCents = Math.round(p.price * 100) * item.qty;
    cents += lineCents;
    lines.push(`<tr><td>${esc(p.name)}</td><td>${esc(item.size)}</td><td>${item.qty}</td><td>PKR ${(lineCents / 100).toFixed(2)}</td></tr>`);
  }
  const total = cents / 100;
  const html = `<h1>New cash-on-delivery order</h1><p>Reference: ${esc(b.client_ref)}</p>` +
    `<p>Name: ${esc(b.name.trim())}<br>Phone: ${esc(b.phone)}<br>Address: ${esc(b.address.trim())}</p>` +
    `<p>Notes: ${esc(b.notes || '')}</p><table><tr><th>Product</th><th>Size</th><th>Quantity</th><th>Line total</th></tr>${lines.join('')}</table>` +
    `<p>Total: PKR ${total.toFixed(2)}</p><p>Verify availability and contact the customer before dispatch. This is an order request, not a payment receipt.</p>`;
  try {
    const response = await fetch('https://api.resend.com/emails', {
      method:'POST', signal:AbortSignal.timeout(10000),
      headers:{Authorization:`Bearer ${env.RESEND_API_KEY}`,'Content-Type':'application/json',
        'Idempotency-Key':`order/${b.client_ref}`},
      body:JSON.stringify({from:env.MAIL_FROM,to:[env.ADMIN_NOTIFY_EMAIL],subject:`ANRAF order ${b.client_ref}`,html}),
    });
    const result = await response.json().catch(() => null);
    if (!response.ok || typeof result?.id !== 'string' || !result.id)
      return json({error:'ORDER_FAILED'},502);
  } catch { return json({error:'ORDER_FAILED'},502); }
  return json({ok:true,ref:b.client_ref,total});
}
