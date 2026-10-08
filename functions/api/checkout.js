// Email-only checkout: server-priced Sanity products, Resend notification, optional Turnstile.
// No database, R2 binding, public customer documents or browser API secrets.
import {readJSON} from '../../shared/request.js';
import {getSanityCatalog, PRODUCT_ID} from '../../shared/sanity.js';

const json = (body, status = 200) => Response.json(body, {status, headers: {
  'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
}});
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

export async function onRequestPost({request, env}) {
  const reqOrigin = request.headers.get('Origin');
  const allowedOrigins = [
    env.SITE_ORIGIN,
    'https://anraaf.com',
    'https://www.anraaf.com',
    'https://nexweb-dot.github.io'
  ].filter(Boolean);

  if (reqOrigin && !allowedOrigins.includes(reqOrigin) && !reqOrigin.endsWith('.pages.dev')) {
    return json({error:'forbidden'}, 403);
  }

  if (env.CHECKOUT_ENABLED === 'false' || !env.RESEND_API_KEY || !env.ADMIN_NOTIFY_EMAIL) {
    return json({error:'CHECKOUT_PAUSED'}, 503);
  }

  if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json')
    return json({error:'bad_content_type'}, 400);

  let b;
  try { b = await readJSON(request); } catch (e) { return json({error:e.message}, e.status || 400); }
  if (b.hp) return json({error:'BAD_INPUT'}, 400);

  if (typeof b.client_ref !== 'string' || !UUID.test(b.client_ref) ||
      typeof b.name !== 'string' || !b.name.trim() || b.name.length > 100 ||
      typeof b.phone !== 'string' || !/^\+923\d{9}$/.test(b.phone) ||
      typeof b.address !== 'string' || !b.address.trim() || b.address.length > 500 ||
      (b.notes != null && (typeof b.notes !== 'string' || b.notes.length > 500)) ||
      !Array.isArray(b.items) || !b.items.length || b.items.length > 30 ||
      b.items.some(i => !i || typeof i.product_id !== 'string' || !PRODUCT_ID.test(i.product_id) ||
        !Number.isInteger(i.qty) || i.qty < 1 || i.qty > 20 || !['Small','Medium','Large','XL'].includes(i.size)) ||
      new Set(b.items.map(i => `${i.product_id}:${i.size}`)).size !== b.items.length)
    return json({error:'BAD_INPUT'}, 400);

  // Optional Turnstile check: only verified if both secret and token exist
  if (env.TURNSTILE_SECRET && typeof b.turnstile_token === 'string' && b.turnstile_token.length > 10) {
    try {
      const result = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
        method: 'POST', signal: AbortSignal.timeout(6000),
        body: new URLSearchParams({secret: env.TURNSTILE_SECRET, response: b.turnstile_token, idempotency_key: b.client_ref}),
      });
      const verified = result.ok && await result.json();
      if (!verified?.success) {
        // Only reject if explicit fail with valid secret
        return json({error:'BOT_CHECK_FAILED'}, 403);
      }
    } catch { /* proceed on timeout to prevent customer drop-off */ }
  }

  let catalog;
  try { catalog = await getSanityCatalog(env, {checkout:true}); }
  catch { return json({error:'CATALOG_UNAVAILABLE'}, 503); }

  const products = new Map(catalog.products.map(p => [p.id, p]));
  const lines = [];
  let cents = 0;
  for (const item of b.items) {
    const p = products.get(item.product_id);
    if (!p) return json({error:'PRODUCT_UNAVAILABLE'}, 409);
    if (!p.in_stock) return json({error:'OUT_OF_STOCK'}, 409);
    if (!p.sizes.includes(item.size)) return json({error:'SIZE_UNAVAILABLE'}, 409);
    const lineCents = Math.round(p.price * 100) * item.qty;
    cents += lineCents;
    lines.push(`<tr><td style="padding:8px 12px;border-bottom:1px solid #eee;"><strong>${esc(p.name)}</strong></td><td style="padding:8px 12px;border-bottom:1px solid #eee;">${esc(item.size)}</td><td style="padding:8px 12px;border-bottom:1px solid #eee;">${item.qty}</td><td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:right;">PKR ${(lineCents / 100).toLocaleString('en-PK')}</td></tr>`);
  }
  const total = cents / 100;

  const isBank = b.payment_method === 'bank' || (typeof b.notes === 'string' && /BANK|WHATSAPP|RAAST/i.test(b.notes));
  const methodBadge = isBank
    ? '<div style="background:#e8f5e9;color:#1b5e20;padding:12px 16px;border-radius:4px;font-weight:bold;margin:15px 0;">PAYMENT METHOD: Direct Bank Transfer / Raast via WhatsApp (Receipt to be verified on WhatsApp)</div>'
    : '<div style="background:#e3f2fd;color:#0d47a1;padding:12px 16px;border-radius:4px;font-weight:bold;margin:15px 0;">PAYMENT METHOD: Cash on Delivery (COD)</div>';

  const html = `
    <div style="font-family:'Segoe UI',sans-serif;max-width:640px;margin:0 auto;padding:24px;background:#ffffff;border:1px solid #e0e0e0;border-radius:6px;color:#1a1a1a;">
      <h2 style="font-size:22px;margin:0 0 10px;color:#111;">ANRAF Studio — New Order Received</h2>
      <p style="font-size:14px;color:#666;margin:0 0 20px;">Order Reference: <strong>#${esc(b.client_ref.slice(0,8).toUpperCase())}</strong> (${esc(b.client_ref)})</p>
      ${methodBadge}
      <div style="background:#fafafa;padding:16px;border-radius:4px;margin-bottom:20px;font-size:14px;line-height:1.6;">
        <p style="margin:0 0 6px;"><strong>Customer:</strong> ${esc(b.name.trim())}</p>
        <p style="margin:0 0 6px;"><strong>WhatsApp / Mobile:</strong> <a href="https://wa.me/${esc(b.phone.replace(/[^0-9]/g,''))}" style="color:#25D366;font-weight:bold;">${esc(b.phone)}</a></p>
        <p style="margin:0 0 6px;"><strong>Delivery Address:</strong> ${esc(b.address.trim())}</p>
        ${b.notes ? `<p style="margin:0;"><strong>Notes:</strong> ${esc(b.notes)}</p>` : ''}
      </div>
      <table style="width:100%;border-collapse:collapse;font-size:14px;margin-bottom:20px;">
        <thead>
          <tr style="background:#f4f4f4;text-align:left;">
            <th style="padding:10px 12px;">Product</th>
            <th style="padding:10px 12px;">Size</th>
            <th style="padding:10px 12px;">Qty</th>
            <th style="padding:10px 12px;text-align:right;">Amount</th>
          </tr>
        </thead>
        <tbody>
          ${lines.join('')}
        </tbody>
      </table>
      <div style="display:flex;justify-content:space-between;padding:14px 12px;background:#111;color:#fff;font-size:16px;font-weight:bold;border-radius:4px;">
        <span>Total Payable</span>
        <span>PKR ${total.toLocaleString('en-PK')}</span>
      </div>
      <p style="font-size:12px;color:#888;margin-top:24px;text-align:center;">ANRAF Studio Automated Dispatch Concierge</p>
    </div>
  `;

  const subject = isBank
    ? `[BANK / WHATSAPP] ANRAF Order #${b.client_ref.slice(0,8).toUpperCase()} — PKR ${total.toLocaleString('en-PK')}`
    : `[COD] ANRAF Order #${b.client_ref.slice(0,8).toUpperCase()} — PKR ${total.toLocaleString('en-PK')}`;

  const primarySender = env.MAIL_FROM || 'orders@anraafstudio.com';

  try {
    let emailRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      signal: AbortSignal.timeout(10000),
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': `order/${b.client_ref}`,
      },
      body: JSON.stringify({
        from: primarySender,
        to: [env.ADMIN_NOTIFY_EMAIL],
        subject,
        html,
      }),
    });

    // If primary sender failed (e.g. unverified custom domain), fall back to onboarding@resend.dev
    if (!emailRes.ok && primarySender !== 'onboarding@resend.dev') {
      emailRes = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        signal: AbortSignal.timeout(8000),
        headers: {
          Authorization: `Bearer ${env.RESEND_API_KEY}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': `order-fallback/${b.client_ref}`,
        },
        body: JSON.stringify({
          from: 'onboarding@resend.dev',
          to: [env.ADMIN_NOTIFY_EMAIL],
          subject: `${subject} (via onboarding@resend.dev)`,
          html,
        }),
      });
    }

    const emailData = await emailRes.json().catch(() => null);
    if (!emailRes.ok || !emailData?.id) {
      console.warn('Resend email dispatch failed:', emailData);
      // Still return order confirmation so customer gets reference and can send via WhatsApp!
    }
  } catch (err) {
    console.warn('Resend fetch exception:', err);
  }

  return json({
    ok: true,
    ref: b.client_ref,
    order_number: b.client_ref.slice(0,8).toUpperCase(),
    total,
    method: isBank ? 'bank' : 'cod'
  });
}
