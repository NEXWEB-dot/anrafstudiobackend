// functions/api/admin/_product-ops.js
// Shared saveProduct / deleteProduct logic — one code path for normal + Emergency Mode.
// Imported by products.js and products/[id].js.

import { rpc, BackendError, isAvailabilityError } from '../../../shared/sb.js';
import { mustUseEmergency, tripBreaker } from '../../../shared/mode.js';
import { syncCatalog, SyncRejected, recordSyncFailure } from '../../../shared/catalog.js';
import { emergencyApply, readAdminSnapshot } from '../../../shared/emergency.js';
import { validateProduct, ValidationError } from '../../../shared/validate.js';

export { ValidationError };

/**
 * Create or update a product. One code path for normal and Emergency Mode.
 * The caller must have already assigned product.id.
 */
export async function saveProduct(env, input) {
  const product = validateProduct(input, env.PUBLIC_CDN_ORIGIN);

  // Read the current admin snapshot to compute which images were removed
  const before = (await readAdminSnapshot(env)).products.find((p) => p.id === product.id);

  if (!(await mustUseEmergency(env))) {
    try {
      await rpc(env, 'admin_upsert_product', { p: product });

      let warning = null;
      try {
        await syncCatalog(env);
      } catch (e) {
        if (e instanceof BackendError && isAvailabilityError(e)) throw e; // → emergency below
        if (!(e instanceof SyncRejected)) throw e;
        await recordSyncFailure(env, e);
        warning = `Saved, but storefront not updated: ${e.message}`;
      }

      await deleteRemovedImages(env, before, product);
      return { mode: 'normal', id: product.id, warning };
    } catch (e) {
      if (!(e instanceof BackendError && isAvailabilityError(e))) throw e;
      await tripBreaker(env, `admin save ${e.status}`);
      // fall through to Emergency Mode
    }
  }

  // Emergency Mode: write directly to R2 and queue for replay
  await emergencyApply(env, {
    id: crypto.randomUUID(),
    ts: Date.now(),
    type: 'upsert_product',
    product,
  });
  await deleteRemovedImages(env, before, product);
  return { mode: 'emergency', id: product.id };
}

export async function deleteProduct(env, id, { confirmShrink = false } = {}) {
  if (!(await mustUseEmergency(env))) {
    try {
      const keys = await (await rpc(env, 'admin_delete_product', { p_id: id })).json();
      try {
        await syncCatalog(env, { allowShrink: confirmShrink });
      } catch (e) {
        if (!(e instanceof SyncRejected)) throw e;
        // Shrink guard rejected; caller gets the result and can force it
      }
      const validKeys = Array.isArray(keys) ? keys.filter((k) => k?.startsWith('img/')) : [];
      if (validKeys.length) await env.PUBLIC.delete(validKeys);
      return { mode: 'normal' };
    } catch (e) {
      if (!(e instanceof BackendError && isAvailabilityError(e))) throw e;
      await tripBreaker(env, `admin delete ${e.status}`);
    }
  }

  // Emergency Mode
  const snap = await readAdminSnapshot(env);
  const p = snap.products.find((x) => x.id === id);
  await emergencyApply(env, {
    id: crypto.randomUUID(),
    ts: Date.now(),
    type: 'delete_product',
    product_id: id,
  });
  const keys = (p?.images ?? [])
    .flatMap((i) => [i.r2_key, i.thumb_r2_key])
    .filter((k) => k?.startsWith('img/'));
  if (keys.length) await env.PUBLIC.delete(keys);
  return { mode: 'emergency' };
}

/** Delete R2 objects for images removed from the product's image list. */
async function deleteRemovedImages(env, before, after) {
  if (!before?.images) return;
  const afterKeys = new Set(
    (after.images ?? []).flatMap((i) => [i.r2_key, i.thumb_r2_key]).filter(Boolean)
  );
  const toDelete = before.images
    .flatMap((i) => [i.r2_key, i.thumb_r2_key])
    .filter((k) => k?.startsWith('img/') && !afterKeys.has(k));
  if (toDelete.length) await env.PUBLIC.delete(toDelete);
}
