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
      (b.email != null && (typeof b.email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.email) || b.email.length > 150)) ||
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
  const subtotal = cents / 100;
  const deliveryFee = Number(env.DELIVERY_FEE || 260);
  const total = subtotal + deliveryFee;
  const shortRef = b.client_ref.slice(0,8).toUpperCase();

  const isBank = b.payment_method === 'bank' || (typeof b.notes === 'string' && /BANK|WHATSAPP|RAAST/i.test(b.notes));
  const methodBadge = isBank
    ? '<div style="background:#e8f5e9;color:#1b5e20;padding:12px 16px;border-radius:4px;font-weight:bold;margin:15px 0;">PAYMENT METHOD: Direct Bank Transfer / Raast via WhatsApp (Receipt to be verified on WhatsApp)</div>'
    : '<div style="background:#e3f2fd;color:#0d47a1;padding:12px 16px;border-radius:4px;font-weight:bold;margin:15px 0;">PAYMENT METHOD: Cash on Delivery (COD)</div>';

  // Admin Notification Email HTML (For store owner / dispatch team)
  const adminHtml = `
    <div style="font-family:'Segoe UI',sans-serif;max-width:640px;margin:0 auto;padding:24px;background:#ffffff;border:1px solid #e0e0e0;border-radius:6px;color:#1a1a1a;">
      <h2 style="font-size:22px;margin:0 0 10px;color:#111;">ANRAF Studio — New Order Received</h2>
      <p style="font-size:14px;color:#666;margin:0 0 20px;">Order Reference: <strong>#${shortRef}</strong> (${esc(b.client_ref)})</p>
      ${methodBadge}
      <div style="background:#fafafa;padding:16px;border-radius:4px;margin-bottom:20px;font-size:14px;line-height:1.6;">
        <p style="margin:0 0 6px;"><strong>Customer:</strong> ${esc(b.name.trim())}</p>
        ${b.email ? `<p style="margin:0 0 6px;"><strong>Email:</strong> <a href="mailto:${esc(b.email.trim())}" style="color:#111;">${esc(b.email.trim())}</a></p>` : ''}
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
          <tr>
            <td colspan="3" style="padding:10px 12px;border-bottom:1px solid #eee;text-align:right;color:#666;"><strong>Subtotal</strong></td>
            <td style="padding:10px 12px;border-bottom:1px solid #eee;text-align:right;">PKR ${subtotal.toLocaleString('en-PK')}</td>
          </tr>
          <tr>
            <td colspan="3" style="padding:10px 12px;border-bottom:1px solid #eee;text-align:right;color:#666;"><strong>Delivery Fee</strong></td>
            <td style="padding:10px 12px;border-bottom:1px solid #eee;text-align:right;">PKR ${deliveryFee.toLocaleString('en-PK')}</td>
          </tr>
        </tbody>
      </table>
      <div style="display:flex;justify-content:space-between;padding:14px 12px;background:#111;color:#fff;font-size:16px;font-weight:bold;border-radius:4px;">
        <span>Total Payable</span>
        <span>PKR ${total.toLocaleString('en-PK')}</span>
      </div>
      <p style="font-size:12px;color:#888;margin-top:24px;text-align:center;">ANRAF Studio Automated Dispatch Concierge</p>
    </div>
  `;

  // Customer Confirmation Email HTML (Sent to b.email)
  const customerItemRows = b.items.map(i => {
    const p = products.get(i.product_id);
    const lineTotal = ((Math.round(p.price * 100) * i.qty) / 100).toLocaleString('en-PK');
    return `
      <tr>
        <td style="padding:14px 0;border-bottom:1px solid #ece8e1;">
          <strong style="font-size:15px;color:#111111;font-family:Georgia,serif;font-weight:500;display:block;">${esc(p.name)}</strong>
          <span style="font-size:11px;color:#777777;">Handcrafted Luxury Prêt</span>
        </td>
        <td align="center" style="padding:14px 8px;border-bottom:1px solid #ece8e1;font-size:13px;color:#333333;">${esc(i.size)}</td>
        <td align="center" style="padding:14px 8px;border-bottom:1px solid #ece8e1;font-size:13px;color:#333333;">${i.qty}</td>
        <td align="right" style="padding:14px 0;border-bottom:1px solid #ece8e1;font-size:14px;font-weight:500;color:#111111;">PKR ${lineTotal}</td>
      </tr>
    `;
  }).join('');

  const customerBankBlock = isBank ? `
    <tr>
      <td style="padding:0 30px 24px;">
        <table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0" style="background-color:#f3f9f4;border:1px solid #c7e3cb;border-radius:4px;">
          <tr>
            <td style="padding:18px;">
              <span style="font-size:11px;font-weight:700;letter-spacing:0.15em;color:#1b5e20;text-transform:uppercase;display:block;margin-bottom:8px;">✦ DIRECT BANK TRANSFER & RAAST INSTANT PAY</span>
              <table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0" style="font-size:12px;color:#222;line-height:1.6;">
                <tr><td width="110" style="color:#666;">Bank:</td><td style="font-weight:600;">Meezan Bank Limited</td></tr>
                <tr><td style="color:#666;">Account Title:</td><td style="font-weight:600;">ANRAF STUDIO</td></tr>
                <tr><td style="color:#666;">Account Number:</td><td style="font-weight:700;font-family:monospace;font-size:13px;">02010108554321</td></tr>
                <tr><td style="color:#666;">IBAN:</td><td style="font-weight:700;font-family:monospace;font-size:12px;">PK45MEZN0002010108554321</td></tr>
                <tr><td style="color:#666;">Raast ID / Mobile:</td><td style="font-weight:700;font-family:monospace;font-size:13px;">03336230844</td></tr>
              </table>
              <p style="margin:10px 0 0;font-size:12px;line-height:1.5;color:#2e7d32;">
                Please share your payment transaction screenshot on WhatsApp to verify instant dispatch.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  ` : '';

  const customerHtml = `
    <!DOCTYPE html>
    <html lang="en">
    <head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Order Confirmation — ANRAF Studio</title></head>
    <body style="margin:0;padding:0;background-color:#f7f6f3;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#1a1a1a;">
      <table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0" style="background-color:#f7f6f3;">
        <tr><td align="center" style="padding:28px 10px;">
          <table role="presentation" width="600" border="0" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background-color:#ffffff;border:1px solid #e8e5de;box-shadow:0 4px 18px rgba(0,0,0,0.04);">
            <tr>
              <td align="center" style="padding:32px 24px 24px;background-color:#111111;border-bottom:2px solid #bfa15f;">
                <p style="margin:0;font-family:Georgia,serif;font-size:30px;letter-spacing:0.28em;color:#ffffff;text-transform:uppercase;">ANRAF</p>
                <p style="margin:4px 0 0;font-size:9px;letter-spacing:0.35em;color:#bfa15f;text-transform:uppercase;">STUDIO · HAUTE COUTURE</p>
              </td>
            </tr>
            <tr>
              <td style="padding:32px 30px 18px;text-align:center;">
                <span style="font-size:10px;font-weight:600;letter-spacing:0.22em;color:#bfa15f;text-transform:uppercase;display:block;margin-bottom:10px;">ORDER CONFIRMATION</span>
                <h1 style="margin:0;font-family:Georgia,serif;font-size:28px;font-weight:400;color:#111111;line-height:1.25;">
                  Thank you for your order, ${esc(b.name.trim())}.
                </h1>
                <p style="margin:12px 0 0;font-size:13px;line-height:1.6;color:#555555;max-width:460px;margin-left:auto;margin-right:auto;">
                  Your luxury ensemble order has been received. Our artisans are now preparing your parcel with the utmost care.
                </p>
              </td>
            </tr>
            <tr>
              <td style="padding:8px 30px 24px;">
                <table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0" style="background-color:#faf9f6;border:1px solid #e8e4db;border-radius:4px;">
                  <tr>
                    <td style="padding:14px 18px;">
                      <span style="font-size:10px;font-weight:600;letter-spacing:0.15em;color:#888888;text-transform:uppercase;display:block;">ORDER NUMBER</span>
                      <span style="font-size:15px;font-weight:700;color:#111111;font-family:monospace;letter-spacing:0.08em;">#${shortRef}</span>
                    </td>
                    <td align="right" style="padding:14px 18px;">
                      <span style="font-size:10px;font-weight:600;letter-spacing:0.15em;color:#888888;text-transform:uppercase;display:block;">ESTIMATED DELIVERY</span>
                      <span style="font-size:12px;color:#222222;font-weight:600;">3–5 Working Days</span>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:0 30px 24px;">
                <table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0">
                  <thead>
                    <tr>
                      <th align="left" style="padding-bottom:10px;font-size:10px;font-weight:600;letter-spacing:0.18em;color:#888;text-transform:uppercase;border-bottom:1px solid #111;">PRODUCT</th>
                      <th align="center" style="padding-bottom:10px;font-size:10px;font-weight:600;letter-spacing:0.18em;color:#888;text-transform:uppercase;border-bottom:1px solid #111;">SIZE</th>
                      <th align="center" style="padding-bottom:10px;font-size:10px;font-weight:600;letter-spacing:0.18em;color:#888;text-transform:uppercase;border-bottom:1px solid #111;">QTY</th>
                      <th align="right" style="padding-bottom:10px;font-size:10px;font-weight:600;letter-spacing:0.18em;color:#888;text-transform:uppercase;border-bottom:1px solid #111;">PRICE</th>
                    </tr>
                  </thead>
                  <tbody>${customerItemRows}</tbody>
                </table>
                <table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0" style="margin-top:10px;">
                  <tr>
                    <td align="right" style="padding:6px 0;font-size:13px;color:#666;">Subtotal</td>
                    <td align="right" width="130" style="padding:6px 0;font-size:13px;font-weight:600;color:#111;">PKR ${subtotal.toLocaleString('en-PK')}</td>
                  </tr>
                  <tr>
                    <td align="right" style="padding:6px 0;font-size:13px;color:#666;">Delivery Fee (Pakistan Nationwide)</td>
                    <td align="right" width="130" style="padding:6px 0;font-size:13px;font-weight:600;color:#111;">PKR ${deliveryFee.toLocaleString('en-PK')}</td>
                  </tr>
                  <tr>
                    <td align="right" style="padding:12px 0;border-top:2px solid #111;font-size:14px;font-weight:700;color:#111;text-transform:uppercase;letter-spacing:0.08em;">Total Payable</td>
                    <td align="right" width="130" style="padding:12px 0;border-top:2px solid #111;font-size:17px;font-weight:700;color:#111;">PKR ${total.toLocaleString('en-PK')}</td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:0 30px 24px;">
                <table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0" style="background-color:#faf9f6;border:1px solid #e8e4db;border-radius:4px;">
                  <tr>
                    <td width="50%" valign="top" style="padding:18px;border-right:1px solid #e8e4db;">
                      <span style="font-size:10px;font-weight:700;letter-spacing:0.15em;color:#bfa15f;text-transform:uppercase;display:block;margin-bottom:6px;">DELIVERY TO</span>
                      <p style="margin:0;font-size:13px;color:#111;font-weight:600;">${esc(b.name.trim())}</p>
                      <p style="margin:3px 0 0;font-size:12px;color:#555;line-height:1.5;">${esc(b.address.trim())}</p>
                      <p style="margin:5px 0 0;font-size:12px;color:#777;">Phone: <strong style="color:#222;">${esc(b.phone)}</strong></p>
                    </td>
                    <td width="50%" valign="top" style="padding:18px;">
                      <span style="font-size:10px;font-weight:700;letter-spacing:0.15em;color:#bfa15f;text-transform:uppercase;display:block;margin-bottom:6px;">PAYMENT</span>
                      <p style="margin:0;font-size:13px;color:#111;font-weight:600;">${isBank ? 'Direct Bank Transfer / Raast' : 'Cash on Delivery (COD)'}</p>
                      <p style="margin:3px 0 0;font-size:12px;color:#666;line-height:1.5;">${isBank ? 'Please transfer amount and verify via WhatsApp.' : 'Pay cash to courier upon arrival.'}</p>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            ${customerBankBlock}
            <tr>
              <td align="center" style="padding:0 30px 30px;">
                <table role="presentation" border="0" cellpadding="0" cellspacing="0">
                  <tr>
                    <td align="center" style="border-radius:3px;background-color:#25d366;">
                      <a href="https://wa.me/923000000000?text=${encodeURIComponent(`Salam ANRAF Studio, regarding my order #${shortRef}`)}" target="_blank" style="font-size:13px;font-weight:600;letter-spacing:0.08em;color:#ffffff;text-decoration:none;padding:12px 26px;display:inline-block;text-transform:uppercase;">
                        Chat with us on WhatsApp →
                      </a>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td align="center" style="padding:26px 20px;background-color:#111111;color:#888888;">
                <p style="margin:0;font-family:Georgia,serif;font-size:17px;letter-spacing:0.2em;color:#ffffff;">ANRAF STUDIO</p>
                <p style="margin:4px 0 0;font-size:10px;color:#888;">Handcrafted luxury prêt and artisanal fashion · Pakistan</p>
              </td>
            </tr>
          </table>
        </td></tr>
      </table>
    </body>
    </html>
  `;

  const subject = isBank
    ? `[BANK / WHATSAPP] ANRAF Order #${shortRef} — PKR ${total.toLocaleString('en-PK')}`
    : `[COD] ANRAF Order #${shortRef} — PKR ${total.toLocaleString('en-PK')}`;

  const primarySender = env.MAIL_FROM || 'orders@anraaf.com';

  let emailRes = null;
  let emailData = null;

  try {
    // 1. Send Order Dispatch Notification to Store Admin
    emailRes = await fetch('https://api.resend.com/emails', {
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
        html: adminHtml,
      }),
    });

    // If primary sender failed, fall back to onboarding@resend.dev
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
          html: adminHtml,
        }),
      });
    }

    emailData = await emailRes.json().catch(() => null);

    // 2. Send Luxury Order Confirmation directly to Customer (if email provided)
    if (b.email && emailRes.ok) {
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        signal: AbortSignal.timeout(8000),
        headers: {
          Authorization: `Bearer ${env.RESEND_API_KEY}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': `customer-receipt/${b.client_ref}`,
        },
        body: JSON.stringify({
          from: primarySender,
          to: [b.email.trim()],
          subject: `Your ANRAF Studio Order Confirmation #${shortRef}`,
          html: customerHtml,
        }),
      }).catch(err => console.warn('Customer receipt send error:', err));
    }
  } catch (err) {
    console.warn('Resend fetch exception:', err);
    emailData = { exception: err.message };
  }

  return json({
    ok: true,
    ref: b.client_ref,
    order_number: shortRef,
    subtotal,
    delivery_fee: deliveryFee,
    total,
    method: isBank ? 'bank' : 'cod',
    resend: {
      ok: emailRes?.ok,
      status: emailRes?.status,
      data: emailData,
    }
  });
}
