import {sanityURL, normalizeSanity} from './sanity-source.js';
export {sanityURL, normalizeSanity, PRODUCT_ID} from './sanity-source.js';
export const CATALOG_TTL = 300;
export const CHECKOUT_TTL = 60;
const pending = new Map();

export async function getSanityCatalog(env, {checkout = false} = {}) {
  const url = sanityURL(env);
  // Separate age limits for browsing and server-side order validation.
  const key = new Request(`${url}&cache-purpose=${checkout ? 'checkout' : 'browse'}`);
  const cache = globalThis.caches?.default;
  const hit = await cache?.match(key).catch(() => null);
  if (hit) return hit.json();
  if (pending.has(key.url)) return pending.get(key.url);
  const task = (async () => {
    const response = await fetch(url, {signal: AbortSignal.timeout(8000)});
    if (!response.ok) throw new Error(`Sanity unavailable (${response.status})`);
    const catalog = normalizeSanity((await response.json()).result, env);
    if (cache) await cache.put(key, Response.json(catalog, {headers: {'Cache-Control': `public, max-age=${checkout ? CHECKOUT_TTL : CATALOG_TTL}`}})).catch(() => {});
    return catalog;
  })();
  pending.set(key.url, task);
  try { return await task; } finally { pending.delete(key.url); }
}
