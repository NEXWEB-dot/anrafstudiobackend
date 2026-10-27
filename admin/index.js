import {Webhook} from 'svix';
import {authenticate, login} from './auth.js';
import {analytics} from './analytics.js';
import {webhookSecret, configureResend} from './integrations.js';
import {UUID, transitions, isOrderEmail, parseOrderEmail, saveOrder, presentOrder, resendGet} from './orders.js';

const fail = (message, status = 400) => {throw Object.assign(new Error(message), {status});};
async function readBody(request, max = 4096) {
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks = []; let size = 0;
  for (;;) {
    const {value, done} = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {await reader.cancel(); fail('Request too large', 413);}
    chunks.push(value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) {bytes.set(chunk, offset); offset += chunk.length;}
  return new TextDecoder().decode(bytes);
}
async function readJSON(request) {
  if (!request.headers.get('Content-Type')?.startsWith('application/json')) fail('JSON body required', 415);
  const raw = await readBody(request);
  try {const result = JSON.parse(raw); if (!result || Array.isArray(result) || typeof result !== 'object') throw new Error(); return result;}
  catch {fail('Invalid JSON');}
}
function requireResend(env) {
  if (!(env.RESEND_ADMIN_API_KEY || env.RESEND_API_KEY) || !env.ADMIN_NOTIFY_EMAIL) fail('Order capture is not configured. Set the server Resend key and notification email.', 503);
}

export async function route(request, env) {
  const url = new URL(request.url), path = url.pathname;
  if (!env.DB) fail('The private orders database is not connected.', 503);
  if (path === '/api/webhooks/resend' && request.method === 'POST') {
    requireResend(env);
    const signingSecret = await webhookSecret(env);
    if (!signingSecret) fail('Webhook is not configured.', 503);
    const raw = await readBody(request, 65536);
    let event;
    try {event = new Webhook(signingSecret).verify(raw, {
      'svix-id':request.headers.get('svix-id'), 'svix-timestamp':request.headers.get('svix-timestamp'), 'svix-signature':request.headers.get('svix-signature'),
    });} catch {fail('Invalid webhook signature', 401);}
    if (event.type !== 'email.sent') return {ignored:true};
    if (!UUID.test(event.data?.email_id || '')) fail('Invalid email ID');
    // Verify the authoritative email, not just the event's subject or recipient.
    const email = await resendGet(env, `/emails/${event.data.email_id}`);
    const order = parseOrderEmail(email, env.ADMIN_NOTIFY_EMAIL);
    return order ? {ok:true, inserted:await saveOrder(env.DB, order)} : {ignored:true};
  }
  if (path === '/api/admin/login' && request.method === 'POST') return login(request, env, await readJSON(request));
  await authenticate(request, env);
  if (request.method === 'POST' && path === '/api/admin/setup-resend') {
    requireResend(env);
    return configureResend(env, url.origin);
  }
  if (request.method === 'GET' && path === '/api/admin/status') {
    await env.DB.prepare('SELECT 1 FROM orders LIMIT 1').first();
    const latest = await env.DB.prepare('SELECT max(imported_at) AS latest FROM orders').first();
    return {connected:true, orderCaptureConfigured:!!((env.RESEND_ADMIN_API_KEY || env.RESEND_API_KEY) && await webhookSecret(env) && env.ADMIN_NOTIFY_EMAIL), latestImport:latest.latest};
  }
  if (request.method === 'GET' && path === '/api/admin/summary') return env.DB.prepare(`SELECT count(*) AS orders, count(DISTINCT customer_phone) AS customers,
    coalesce(sum(CASE WHEN status='pending' THEN 1 ELSE 0 END),0) AS pending,
    coalesce(sum(CASE WHEN status!='cancelled' THEN total_cents ELSE 0 END),0)/100.0 AS orderValue,
    coalesce(sum(CASE WHEN status='delivered' THEN total_cents ELSE 0 END),0)/100.0 AS deliveredValue FROM orders`).first();
  if (request.method === 'GET' && path === '/api/admin/orders') {
    const status = url.searchParams.get('status') || '';
    if (status && !Object.hasOwn(transitions, status)) fail('Invalid status');
    const q = (url.searchParams.get('q') || '').trim();
    if (q.length > 100) fail('Search is too long');
    const page = Number(url.searchParams.get('page') || 1);
    if (!Number.isSafeInteger(page) || page < 1 || page > 100000) fail('Invalid page');
    const where = "WHERE (?='' OR status=?) AND (?='' OR instr(lower(customer_name),lower(?))>0 OR instr(customer_phone,?)>0 OR instr(lower(order_number),lower(?))>0)";
    const args = [status,status,q,q,q,q];
    const results = await env.DB.batch([
      env.DB.prepare(`SELECT count(*) AS total FROM orders ${where}`).bind(...args),
      env.DB.prepare(`SELECT * FROM orders ${where} ORDER BY created_at DESC,id DESC LIMIT 25 OFFSET ?`).bind(...args,(page-1)*25),
    ]);
    return {total:results[0].results[0].total, page, pageSize:25, orders:results[1].results.map(presentOrder)};
  }
  const detail = /^\/api\/admin\/orders\/([a-f0-9-]{36})$/.exec(path);
  if (detail && UUID.test(detail[1])) {
    if (request.method === 'GET') {
      const order = presentOrder(await env.DB.prepare('SELECT * FROM orders WHERE id=?').bind(detail[1]).first());
      if (!order) fail('Order not found',404);
      return {order};
    }
    if (request.method === 'PATCH') {
      const body = await readJSON(request);
      if (!Object.hasOwn(transitions,body.from) || !transitions[body.from].includes(body.status)) fail('Invalid order status transition');
      const result = await env.DB.prepare("UPDATE orders SET status=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND status=?").bind(body.status,detail[1],body.from).run();
      if (!result.meta.changes) fail('This order changed in another session. Reload before updating.',409);
      return {ok:true};
    }
  }
  if (request.method === 'GET' && path === '/api/admin/analytics') return analytics(env);
  if (request.method === 'GET' && path === '/api/admin/products') {
    const project = env.SANITY_PROJECT_ID || 'm7hktaor', dataset = env.SANITY_DATASET || 'production';
    if (!/^[a-z0-9]+$/.test(project) || !/^[a-z0-9_-]+$/.test(dataset)) fail('Invalid catalog configuration',503);
    const target = new URL(`https://${project}.apicdn.sanity.io/v2026-10-08/data/query/${dataset}`);
    target.searchParams.set('perspective','published');
    target.searchParams.set('query','*[_type == "product" && isActive == true] | order(sortOrder asc, _id asc){"id":_id,name,"slug":slug.current,price,discountPercent,category,"in_stock":availability == "in-stock",sizes}');
    const response = await fetch(target,{signal:AbortSignal.timeout(10000)});
    if (!response.ok) fail('Product catalog is unavailable',502);
    const data = await response.json();
    if (!Array.isArray(data.result)) fail('Product catalog is unavailable',502);
    return {products:data.result.map(p => ({...p, price:Math.round(p.price*100*(100-(p.discountPercent || 0))/100)/100}))};
  }
  if (request.method === 'POST' && path === '/api/admin/import') {
    requireResend(env);
    const body = await readJSON(request);
    // An explicit email ID allows recovery of an individual order.
    if (body.emailId) {
      if (!UUID.test(body.emailId)) fail('Invalid Resend email ID');
      const order = parseOrderEmail(await resendGet(env,`/emails/${body.emailId}`),env.ADMIN_NOTIFY_EMAIL);
      if (!order) fail('This is not an ANRAF admin order notification');
      return {imported:Number(await saveOrder(env.DB,order)), next:null};
    }
    if (body.after && !UUID.test(body.after)) fail('Invalid import cursor');
    const page = await resendGet(env,`/emails?limit=5${body.after ? `&after=${body.after}` : ''}`);
    if (!Array.isArray(page.data)) fail('Resend returned an invalid email list',502);
    let imported = 0;
    for (const item of page.data) {
      if (!isOrderEmail(item,env.ADMIN_NOTIFY_EMAIL)) continue;
      // Resend defaults to 2 requests/second; imports are deliberately paced.
      await new Promise(resolve => setTimeout(resolve,600));
      const order = parseOrderEmail(await resendGet(env,`/emails/${item.id}`),env.ADMIN_NOTIFY_EMAIL);
      if (order) imported += Number(await saveOrder(env.DB,order));
    }
    return {imported, scanned:page.data.length, next:page.has_more ? page.data.at(-1)?.id : null};
  }
  fail('Endpoint not found',404);
}

export default {
  async fetch(request,env) {
    const origin = request.headers.get('Origin');
    const allowed = origin && origin === env.ADMIN_ORIGIN;
    const headers = {'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff', 'Vary':'Origin', 'Content-Type':'application/json'};
    if (allowed) Object.assign(headers, {'Access-Control-Allow-Origin':origin,'Access-Control-Allow-Headers':'Authorization, Content-Type','Access-Control-Allow-Methods':'GET, POST, PATCH, OPTIONS'});
    if (origin && !allowed) return new Response(JSON.stringify({error:'Origin not allowed'}),{status:403,headers});
    if (request.method === 'OPTIONS') return new Response(null,{status:204,headers});
    try {return new Response(JSON.stringify(await route(request,env)),{headers});}
    catch (error) {
      const status = error.status || 500;
      // Do not return SQL errors, credentials or email bodies to the browser.
      return new Response(JSON.stringify({error:status === 500 ? 'Unable to complete the request. Check the private service configuration or order email format and retry.' : error.message}), {status,headers});
    }
  },
};
