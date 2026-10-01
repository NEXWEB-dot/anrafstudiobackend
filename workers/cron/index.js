// workers/cron/index.js
// Cron Worker for ANRAF Studio Store
// Three cron triggers:
//   */5 * * * *  — probe: check Supabase, replay emergency queue
//   0 */6 * * *  — reconcile: keep-alive + repair any missed sync
//   0 3 * * *    — nightly: backup, prune, orphan sweep, deploy hook

import { sb, BackendError, isAvailabilityError } from '../../shared/sb.js';
import { getMode, tripBreaker } from '../../shared/mode.js';
import { syncCatalog, recordSyncFailure } from '../../shared/catalog.js';
import { replayPending } from '../../shared/emergency.js';
import { alertOnce } from '../../shared/alerts.js';

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(run(event.cron, env));
  },
};

async function run(cron, env) {
  try {
    if (cron === '*/5 * * * *')  return await probe(env);
    if (cron === '0 */6 * * *') return await reconcile(env);
    if (cron === '0 3 * * *')   return await nightly(env);
  } catch (e) {
    await alertOnce(env, `cron-${cron}`, `Cron ${cron} failed: ${e}`);
  }
}

// ─── PROBE (every 5 min) ─────────────────────────────────────────────────────
// Cheap R2 reads; only touches Supabase if there is something to replay.
async function probe(env) {
  const mode = await getMode(env);

  const [opsObj, ordersResult] = await Promise.all([
    env.PRIVATE.get('state/pending-ops.json'),
    env.PRIVATE.list({ prefix: 'orders-pending/', limit: 1 }),
  ]);

  const hasQueue = opsObj
    ? ((await opsObj.json()).ops?.length ?? 0) > 0
    : false;
  const hasOrders = ordersResult.objects.length > 0;

  // Nothing to do if we're in normal mode and the queue is empty
  if (mode.mode !== 'emergency' && !hasQueue && !hasOrders) return;

  // Test Supabase with a cheap query
  try {
    await sb(env, 'products?select=id&limit=1');
  } catch (e) {
    if (e instanceof BackendError && isAvailabilityError(e)) return; // still down
    throw e;
  }

  // Supabase is back — replay everything
  await replayPending(env);

  // Alert if ops have been waiting > 1 hour (stuck queue)
  const q = await env.PRIVATE.get('state/pending-ops.json');
  if (q) {
    const data = await q.json();
    if (data?.ops?.some((o) => Date.now() - o.ts > 3600_000)) {
      await alertOnce(env, 'queue-stuck', 'Pending changes older than 1 hour are not syncing.');
    }
  }
}

// ─── RECONCILE (every 6 hours) ───────────────────────────────────────────────
// Keep-alive (a real query prevents Supabase free-tier inactivity pause).
// Also repairs any sync that was missed between manual saves.
async function reconcile(env) {
  try {
    await sb(env, 'products?select=id&limit=1');
    await syncCatalog(env);
  } catch (e) {
    if (e instanceof BackendError && isAvailabilityError(e)) {
      await tripBreaker(env, `reconcile ${e.status}`);
      return;
    }
    await recordSyncFailure(env, e);
    await alertOnce(env, 'sync-failed', `Catalog sync failed during reconcile: ${e}`);
  }
}

// ─── NIGHTLY (03:00 UTC) ─────────────────────────────────────────────────────
async function nightly(env) {
  await exportBackup(env);
  await pruneBackups(env);
  await sweepOrphans(env);
  await checkOrderFlood(env);
  // Trigger a Pages deploy to refresh /data/products.fallback.json
  if (env.DEPLOY_HOOK_URL) {
    await fetch(env.DEPLOY_HOOK_URL, { method: 'POST' }).catch(() => {});
  }
}

// ─── BACKUP EXPORT ───────────────────────────────────────────────────────────
async function exportBackup(env) {
  try {
    const curObj = await env.PRIVATE.get('state/backup-cursor.json');
    const since = curObj ? (await curObj.json()).since : '1970-01-01T00:00:00Z';
    const day = new Date().toISOString().slice(0, 10);

    const rows = [];
    let offset = 0;
    let maxTs = since;

    // Page through orders updated since last backup
    // Cap at 20,000 rows to stay within the 50-subrequest free-plan limit
    for (;;) {
      const r = await sb(
        env,
        `orders?select=*,order_items(*)&updated_at=gt.${encodeURIComponent(since)}&order=updated_at.asc&limit=1000&offset=${offset}`
      );
      const page = await r.json();
      if (!page.length) break;
      rows.push(...page);
      maxTs = page[page.length - 1].updated_at;
      offset += page.length;
      if (page.length < 1000 || offset >= 20_000) break;
    }

    if (rows.length) {
      await env.PRIVATE.put(`backups/db/orders-${day}.json`, JSON.stringify(rows));
    }

    // Also snapshot the current product catalog
    const admObj = await env.PRIVATE.get('catalog/admin-products.json');
    if (admObj) {
      await env.PRIVATE.put(`backups/db/products-${day}.json`, await admObj.text());
    }

    await env.PRIVATE.put(
      'state/backup-cursor.json',
      JSON.stringify({ since: maxTs })
    );
  } catch (e) {
    await alertOnce(env, 'backup-failed', `Nightly backup failed: ${e}`);
  }
}

// ─── PRUNE OLD BACKUPS ───────────────────────────────────────────────────────
async function pruneBackups(env) {
  try {
    const now = Date.now();
    const CATALOG_TTL = 14 * 86_400_000; // 14 days
    const DB_TTL = 30 * 86_400_000;      // 30 days

    for (const { prefix, ttl } of [
      { prefix: 'backups/catalog/', ttl: CATALOG_TTL },
      { prefix: 'backups/db/', ttl: DB_TTL },
    ]) {
      let cursor;
      do {
        const r = await env.PRIVATE.list({ prefix, cursor });
        const toDelete = r.objects
          .filter((o) => o.uploaded && now - new Date(o.uploaded).getTime() > ttl)
          .map((o) => o.key);
        if (toDelete.length) await env.PRIVATE.delete(toDelete);
        cursor = r.truncated ? r.cursor : undefined;
      } while (cursor);
    }
  } catch (e) {
    await alertOnce(env, 'prune-failed', `Backup pruning failed: ${e}`);
  }
}

// ─── ORPHAN SWEEP ────────────────────────────────────────────────────────────
// Delete PUBLIC img/* objects that are not referenced by the admin catalog
// AND are older than 24 hours. Capped at 500 objects per run.
async function sweepOrphans(env) {
  try {
    const admObj = await env.PRIVATE.get('catalog/admin-products.json');
    if (!admObj) return;

    const adm = await admObj.json();
    const referenced = new Set();
    for (const p of adm.products ?? []) {
      for (const img of p.images ?? []) {
        if (img.r2_key) referenced.add(img.r2_key);
        if (img.thumb_r2_key) referenced.add(img.thumb_r2_key);
      }
    }

    const now = Date.now();
    const ONE_DAY = 86_400_000;
    let deleted = 0;
    let cursor;

    do {
      const r = await env.PUBLIC.list({ prefix: 'img/', cursor });
      for (const obj of r.objects) {
        if (deleted >= 500) break;
        if (!referenced.has(obj.key) && obj.uploaded && now - new Date(obj.uploaded).getTime() > ONE_DAY) {
          await env.PUBLIC.delete(obj.key);
          deleted++;
        }
      }
      cursor = r.truncated && deleted < 500 ? r.cursor : undefined;
    } while (cursor);
  } catch (e) {
    await alertOnce(env, 'orphan-sweep-failed', `Orphan image sweep failed: ${e}`);
  }
}

// ─── ORDER FLOOD CHECK ───────────────────────────────────────────────────────
// Alert if an unusual number of orders arrived in the last hour.
async function checkOrderFlood(env) {
  try {
    const since = new Date(Date.now() - 3_600_000).toISOString();
    const res = await sb(
      env,
      `orders?select=id&created_at=gte.${encodeURIComponent(since)}&limit=1`,
      { headers: { Prefer: 'count=exact' } }
    );
    const contentRange = res.headers.get('Content-Range') ?? '';
    const total = Number(contentRange.split('/')[1]) || 0;
    const THRESHOLD = 30; // tune for the client's volume
    if (total > THRESHOLD) {
      await alertOnce(
        env,
        'order-flood',
        `${total} orders in the last hour (threshold: ${THRESHOLD}). Possible spam — consider pausing checkout.`
      );
    }
  } catch (e) {
    // Non-critical; don't alert on failure
    console.error('checkOrderFlood failed:', e);
  }
}
