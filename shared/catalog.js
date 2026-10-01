// shared/catalog.js — guarded catalog sync Supabase → R2
// syncCatalog() rebuilds both catalog files, validates them, keeps a dated
// backup, and only then overwrites the live file. Idempotent: concurrent runs
// converge on the same result.

import { rpc } from './sb.js';

export class SyncRejected extends Error {}

// Peek at the "count" field without full JSON.parse (keeps CPU tiny on free plan).
// The catalog_public() SQL function intentionally puts "count" first.
const peekCount = (text) => {
  const m = /^\s*\{\s*"count"\s*:\s*(\d+)/.exec(text.slice(0, 80));
  if (!m) throw new SyncRejected('catalog shape invalid');
  return Number(m[1]);
};

/**
 * Full rebuild from Supabase → validate → backup → publish.
 * @param {allowShrink} set true for manual "publish anyway" and post-recovery syncs
 */
export async function syncCatalog(env, { allowShrink = false } = {}) {
  // Two RPCs piped as text — no JSON.parse keeps CPU tiny
  const [pubRes, admRes] = await Promise.all([
    rpc(env, 'catalog_public'),
    rpc(env, 'catalog_admin'),
  ]);
  const [pubText, admText] = await Promise.all([pubRes.text(), admRes.text()]);

  // ---- validation: never publish garbage ----
  const count = peekCount(pubText);
  if (pubText.length > 8_000_000) throw new SyncRejected('catalog too large');

  const prevObj = await env.PRIVATE.get('state/sync.json');
  const prev = prevObj ? await prevObj.json() : { count: 0 };

  if (!allowShrink) {
    if (count === 0 && prev.count > 0)
      throw new SyncRejected('refusing to publish an empty catalog');
    if (prev.count >= 10 && count < prev.count * 0.5)
      throw new SyncRejected(`catalog shrank ${prev.count} → ${count}`);
  }

  // ---- publish (backup first, then admin snapshot, then live file) ----
  const now = new Date().toISOString();
  // One file per hour, overwritten within the hour (keeps 14 days manageable)
  await env.PRIVATE.put(
    `backups/catalog/${now.slice(0, 10)}/${now.slice(11, 13)}.json`,
    pubText
  );
  await env.PRIVATE.put('catalog/admin-products.json', admText, {
    httpMetadata: { contentType: 'application/json' },
  });
  await publishPublic(env, pubText);
  await env.PRIVATE.put(
    'state/sync.json',
    JSON.stringify({ ok: true, ts: Date.now(), count })
  );
  return { count };
}

/**
 * Write the public catalog to the PUBLIC R2 bucket + optional CDN purge.
 */
export async function publishPublic(env, jsonText) {
  await env.PUBLIC.put('catalog/products.json', jsonText, {
    httpMetadata: {
      contentType: 'application/json; charset=utf-8',
      cacheControl: 'public, max-age=60, stale-while-revalidate=600',
    },
  });
  // Optional instant cache purge (only when CF_API_TOKEN is set)
  if (env.CF_API_TOKEN) {
    await fetch(
      `https://api.cloudflare.com/client/v4/zones/${env.CF_ZONE_ID}/purge_cache`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.CF_API_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          files: [`${env.PUBLIC_CDN_ORIGIN}/catalog/products.json`],
        }),
      }
    ).catch(() => {}); // purge failure is non-fatal; TTL covers it
  }
}

/**
 * Record a sync failure without overwriting the last good count
 * so the shrink guard keeps working after a failed sync.
 */
export async function recordSyncFailure(env, err) {
  const o = await env.PRIVATE.get('state/sync.json');
  const prev = o ? await o.json() : {};
  await env.PRIVATE.put(
    'state/sync.json',
    JSON.stringify({ ...prev, ok: false, failed_ts: Date.now(), error: String(err) })
  );
}
