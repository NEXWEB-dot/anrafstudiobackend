// shared/emergency.js — Emergency Mode: dashboard edits R2 directly when Supabase is down
import { rpc, BackendError, isAvailabilityError } from './sb.js';
import { publishPublic, syncCatalog } from './catalog.js';
import { clearBreaker } from './mode.js';
import { alertOnce } from './alerts.js';

export async function readAdminSnapshot(env) {
  const o = await env.PRIVATE.get('catalog/admin-products.json');
  return o
    ? o.json()
    : { count: 0, version: 1, generated_at: new Date(0).toISOString(), products: [] };
}

/**
 * Optimistic-concurrency update using R2 ETags (compare-and-swap).
 * Retries up to 6 times on contention before throwing.
 */
export async function casUpdate(bucket, key, mutate, fallback) {
  for (let i = 0; i < 6; i++) {
    const cur = await bucket.get(key);
    const next = await mutate(cur ? await cur.json() : structuredClone(fallback));
    const put = await bucket.put(key, JSON.stringify(next), {
      httpMetadata: { contentType: 'application/json' },
      onlyIf: cur ? { etagMatches: cur.etag } : { etagDoesNotMatch: '*' },
    });
    if (put) return next; // null = precondition failed → retry
  }
  throw new Error('casUpdate: too much contention');
}

/** Apply one op (upsert or delete) to an admin snapshot. Pure function. */
export function applyOp(snap, op) {
  let products = snap.products.slice();
  if (op.type === 'upsert_product') {
    const i = products.findIndex((p) => p.id === op.product.id);
    if (i >= 0) products[i] = { ...products[i], ...op.product };
    else products.unshift(op.product);
  } else if (op.type === 'delete_product') {
    products = products.filter((p) => p.id !== op.product_id);
  }
  return { ...snap, count: products.length, generated_at: new Date().toISOString(), products };
}

/** Strip admin-only fields to produce the public catalog shape. */
export function derivePublic(adm) {
  const products = adm.products
    .filter((p) => p.is_active)
    .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
    .map((p) => ({
      id: p.id,
      slug: p.slug,
      name: p.name,
      description: p.description,
      price: p.price,
      compare_at_price: p.compare_at_price ?? null,
      category: p.category ?? null,
      in_stock: !!p.in_stock && (!p.track_stock || p.stock > 0),
      images: (p.images ?? []).map((i) => ({ url: i.url, thumb: i.thumb_url ?? null })),
    }));
  return {
    count: products.length,
    version: 1,
    generated_at: adm.generated_at,
    products,
  };
}

/**
 * Queue an op + immediately update both catalog files in R2.
 * Order: 1) queue (durable), 2) admin snapshot, 3) public file.
 * A crash between steps is safe: probe replays from the queue.
 */
export async function emergencyApply(env, op) {
  await casUpdate(
    env.PRIVATE,
    'state/pending-ops.json',
    (q) => ({ ops: [...(q.ops ?? []), op] }),
    { ops: [] }
  );
  const adm = await casUpdate(
    env.PRIVATE,
    'catalog/admin-products.json',
    (s) => applyOp(s, op),
    { count: 0, version: 1, generated_at: new Date().toISOString(), products: [] }
  );
  await publishPublic(env, JSON.stringify(derivePublic(adm)));
}

/**
 * Replay all queued ops (products then orders) into Supabase.
 * Called by the cron probe after Supabase recovers.
 */
export async function replayPending(env) {
  const qObj = await env.PRIVATE.get('state/pending-ops.json');
  const ops = qObj ? (await qObj.json()).ops ?? [] : [];

  for (const op of ops) {
    try {
      if (op.type === 'upsert_product')
        await rpc(env, 'admin_upsert_product', { p: op.product });
      else if (op.type === 'delete_product')
        await rpc(env, 'admin_delete_product', { p_id: op.product_id });

      // Remove successfully replayed op from the queue
      await casUpdate(
        env.PRIVATE,
        'state/pending-ops.json',
        (q) => ({ ops: q.ops.filter((o) => o.id !== op.id) }),
        { ops: [] }
      );
    } catch (e) {
      if (e instanceof BackendError && isAvailabilityError(e))
        return { stopped: true }; // still down — stop, let probe retry

      // Permanent failure (e.g. duplicate slug): park it and alert
      await casUpdate(
        env.PRIVATE,
        'state/pending-failed.json',
        (q) => ({ ops: [...(q.ops ?? []), { ...op, error: String(e.body ?? e) }] }),
        { ops: [] }
      );
      await casUpdate(
        env.PRIVATE,
        'state/pending-ops.json',
        (q) => ({ ops: q.ops.filter((o) => o.id !== op.id) }),
        { ops: [] }
      );
      await alertOnce(
        env,
        `replay-failed-${op.id}`,
        `Replay of ${op.type} failed permanently: ${e.body ?? e}`
      );
    }
  }

  // Replay offline orders (force-insert, idempotent by client_ref)
  for await (const key of listAll(env.PRIVATE, 'orders-pending/')) {
    const o = await (await env.PRIVATE.get(key)).json();
    try {
      await rpc(env, 'place_order', {
        p_client_ref: o.client_ref,
        p_name: o.name,
        p_phone: o.phone,
        p_address: o.address,
        p_notes: o.notes,
        p_items: o.items.map((i) => ({
          product_id: i.product_id,
          qty: i.qty,
          name: i.name,
          price: i.price,
          size: i.size ?? 'Small',
        })),
        p_force: true,
      });
      await env.PRIVATE.delete(key);
    } catch (e) {
      if (e instanceof BackendError && isAvailabilityError(e))
        return { stopped: true };
      await alertOnce(
        env,
        `order-replay-${o.client_ref}`,
        `Offline order ${o.client_ref} could not be replayed: ${e.body ?? e}`
      );
    }
  }

  // Rebuild R2 from the source of truth now that everything is replayed
  const remaining = await env.PRIVATE.get('state/pending-ops.json');
  const pendingOrders = await env.PRIVATE.list({ prefix: 'orders-pending/', limit: 1 });
  if ((remaining && (await remaining.json()).ops?.length) || pendingOrders.objects.length)
    return { stopped: true };
  await syncCatalog(env, { allowShrink: true });
  await clearBreaker(env);
  return { replayed: ops.length };
}

async function* listAll(bucket, prefix) {
  let cursor;
  do {
    const r = await bucket.list({ prefix, cursor });
    for (const o of r.objects) yield o.key;
    cursor = r.truncated ? r.cursor : undefined;
  } while (cursor);
}
