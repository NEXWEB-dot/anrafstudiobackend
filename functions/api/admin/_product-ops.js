// functions/api/admin/_product-ops.js
// Shared saveProduct / deleteProduct logic — one code path for normal + Emergency Mode.
// Imported by products.js and products/[id].js.

import { rpc, BackendError, isAvailabilityError } from '../../../shared/sb.js';
import { mustUseEmergency, tripBreaker } from '../../../shared/mode.js';
import { syncCatalog, SyncRejected, recordSyncFailure } from '../../../shared/catalog.js';
import { emergencyApply } from '../../../shared/emergency.js';
import { validateProduct, ValidationError } from '../../../shared/validate.js';

export { ValidationError };

/**
 * Create or update a product. One code path for normal and Emergency Mode.
 * The caller must have already assigned product.id.
 */
export async function saveProduct(env, input) {
  const product = validateProduct(input, env.PUBLIC_CDN_ORIGIN);

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

      // Leave old images for the delayed orphan sweep, including when publication failed.
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
  return { mode: 'emergency', id: product.id };
}

export async function deleteProduct(env, id, { confirmShrink = false } = {}) {
  if (!(await mustUseEmergency(env))) {
    try {
      await rpc(env, 'admin_delete_product', { p_id: id });
      let warning = null;
      try {
        await syncCatalog(env, { allowShrink: confirmShrink });
      } catch (e) {
        if (!(e instanceof SyncRejected)) throw e;
        await recordSyncFailure(env, e);
        warning = `Deleted, but storefront publication needs confirmation: ${e.message}`;
      }
      // A still-published catalog can reference these images; the orphan sweep owns cleanup.
      return { mode: 'normal', warning };
    } catch (e) {
      if (!(e instanceof BackendError && isAvailabilityError(e))) throw e;
      await tripBreaker(env, `admin delete ${e.status}`);
    }
  }

  // Emergency Mode
  await emergencyApply(env, {
    id: crypto.randomUUID(),
    ts: Date.now(),
    type: 'delete_product',
    product_id: id,
  });
  return { mode: 'emergency' };
}
