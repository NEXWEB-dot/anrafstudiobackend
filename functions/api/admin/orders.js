// functions/api/admin/orders.js — GET orders
// Normal mode: Supabase with pagination + status filter
// Emergency mode: offline-captured orders from R2 only
import { sb, BackendError, isAvailabilityError } from '../../../shared/sb.js';
import { getMode } from '../../../shared/mode.js';

const json = (o, s = 200) =>
  new Response(JSON.stringify(o), {
    status: s,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

const VALID_STATUSES = new Set(['pending', 'confirmed', 'shipped', 'delivered', 'cancelled']);

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const mode = await getMode(env);

  if (mode.mode === 'emergency') {
    // Return offline-captured orders from R2 only
    const r = await env.PRIVATE.list({ prefix: 'orders-pending/', limit: 100 });
    const orders = await Promise.all(
      r.objects.map(async (obj) => {
        const o = await (await env.PRIVATE.get(obj.key)).json();
        return { ...o, _source: 'offline' };
      })
    );
    return json({
      orders,
      total: orders.length,
      emergency: true,
      message: 'Showing orders captured while the database was unavailable.',
    });
  }

  // Normal mode: Supabase query
  const limit = Math.min(Number(url.searchParams.get('limit') ?? 50), 100);
  const offset = Math.max(Number(url.searchParams.get('offset') ?? 0), 0);
  const statusParam = url.searchParams.get('status');

  let query = `orders?select=*,order_items(*)&order=created_at.desc&limit=${limit}&offset=${offset}`;
  if (statusParam && VALID_STATUSES.has(statusParam)) {
    query += `&status=eq.${statusParam}`;
  }

  try {
    const res = await sb(env, query, { headers: { Prefer: 'count=exact' } });
    const orders = await res.json();
    const contentRange = res.headers.get('Content-Range') ?? '';
    const total = Number(contentRange.split('/')[1]) || orders.length;
    return json({ orders, total, limit, offset });
  } catch (e) {
    if (e instanceof BackendError && isAvailabilityError(e))
      return json({ error: 'database_unavailable' }, 503);
    return json({ error: 'server_error' }, 500);
  }
}
