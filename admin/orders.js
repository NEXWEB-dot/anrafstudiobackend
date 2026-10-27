import {parseHTML} from 'linkedom';

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const transitions = {pending:['confirmed','cancelled'], confirmed:['shipped','cancelled'], shipped:['delivered','cancelled'], delivered:[], cancelled:[]};
export function isOrderEmail(email, recipient) {
  return !!recipient && (email.to || []).some(to => to.toLowerCase() === recipient.toLowerCase()) &&
    /^\[(COD|BANK \/ WHATSAPP)\] ANRAF Order #[A-F0-9]{8} — PKR /.test(email.subject || '');
}
function money(value) {
  const text = value.replace(/^PKR\s*/, '').replaceAll(',', '').trim();
  if (!/^\d+(\.\d{1,2})?$/.test(text)) throw new Error('Order email amount is invalid');
  const cents = Math.round(Number(text) * 100);
  if (!Number.isSafeInteger(cents)) throw new Error('Order amount is too large');
  return cents;
}

// Reads the existing admin notification template, never executes email markup.
export function parseOrderEmail(email, recipient) {
  if (!isOrderEmail(email, recipient)) return null;
  if (!UUID.test(email.id || '') || typeof email.html !== 'string' || email.html.length > 200000) throw new Error('Order email is missing its contents');
  const {document} = parseHTML(`<html><body>${email.html}</body></html>`);
  const paragraphs = [...document.querySelectorAll('p')];
  const refText = paragraphs.find(p => p.textContent.trim().startsWith('Order Reference:'))?.textContent || '';
  const id = /\(([a-f0-9-]{36})\)/i.exec(refText)?.[1]?.toLowerCase();
  if (!UUID.test(id || '') || !email.subject.includes(`#${id.slice(0,8).toUpperCase()}`)) throw new Error('Order reference is invalid');
  const field = label => {
    const p = paragraphs.find(p => p.querySelector('strong')?.textContent.trim() === `${label}:`);
    return p ? p.textContent.trim().slice(label.length + 1).trim() : '';
  };
  const items = [...document.querySelectorAll('tbody tr')].map(tr => {
    const cells = [...tr.querySelectorAll('td')].map(td => td.textContent.trim());
    if (cells.length !== 4 || !/^\d+$/.test(cells[2])) throw new Error('Order line is invalid');
    const quantity = Number(cells[2]);
    const lineCents = money(cells[3]);
    if (!cells[0] || !['Small','Medium','Large','XL'].includes(cells[1]) || quantity < 1 || quantity > 20 || lineCents % quantity) throw new Error('Order line is invalid');
    return {product_name:cells[0], size:cells[1], quantity, price_at_purchase:lineCents / quantity / 100};
  });
  const totalElement = [...document.querySelectorAll('span')].find(s => s.textContent.trim() === 'Total Payable');
  const totalCents = money(totalElement?.nextElementSibling?.textContent || '');
  if (!items.length || items.length > 30 || Math.round(items.reduce((sum,i) => sum + i.price_at_purchase * i.quantity, 0) * 100) !== totalCents) throw new Error('Order email totals do not match');
  const customer_name = field('Customer'), customer_phone = field('WhatsApp / Mobile'), customer_address = field('Delivery Address');
  // Resend timestamps can use a PostgreSQL-style space and +00 suffix.
  const timestamp = String(email.created_at || '').replace(' ', 'T').replace(/\+00$/, 'Z');
  const created = new Date(timestamp);
  if (!customer_name || !/^\+923\d{9}$/.test(customer_phone) || !customer_address || Number.isNaN(created.getTime())) throw new Error('Order customer details are invalid');
  return {id, email_id:email.id, order_number:id.slice(0,8).toUpperCase(), customer_name,
    customer_email:field('Email'), customer_phone, customer_address, notes:field('Notes'),
    payment_method:email.subject.startsWith('[BANK') ? 'bank' : 'cod', total_cents:totalCents,
    items_json:JSON.stringify(items), created_at:created.toISOString()};
}

export async function saveOrder(db, order) {
  const keys = Object.keys(order);
  const result = await db.prepare(`INSERT INTO orders (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')}) ON CONFLICT(id) DO NOTHING`).bind(...Object.values(order)).run();
  return result.meta.changes > 0;
}
export function presentOrder(row) {
  if (!row) return null;
  const {items_json, total_cents, ...order} = row;
  return {...order, client_ref:order.id, total:total_cents / 100, order_items:JSON.parse(items_json)};
}
export async function resendGet(env, path) {
  const response = await fetch(`https://api.resend.com${path}`, {headers:{Authorization:`Bearer ${env.RESEND_ADMIN_API_KEY || env.RESEND_API_KEY}`}, signal:AbortSignal.timeout(10000)});
  if (!response.ok) throw Object.assign(new Error(`Resend request failed (${response.status}). Check the server key and try again.`), {status:502});
  return response.json();
}
