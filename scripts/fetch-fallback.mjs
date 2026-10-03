// scripts/fetch-fallback.mjs
// Runs as the Cloudflare Pages build command: node scripts/fetch-fallback.mjs
// Downloads the live catalog from R2 CDN to refresh the committed fallback copy.
// NEVER fails the build — if the fetch fails, the committed seed copy is kept.
import { mkdir, writeFile } from 'node:fs/promises';

try {
  const cdnOrigin = process.env.PUBLIC_CDN_ORIGIN;
  if (!cdnOrigin) throw new Error('PUBLIC_CDN_ORIGIN env var not set');

  const r = await fetch(`${cdnOrigin}/catalog/products.json`, {
    signal: AbortSignal.timeout(8000),
  });
  const j = await r.json();
  if (!r.ok || !Array.isArray(j.products)) throw new Error('bad payload');

  const output = new URL('../public/data/', import.meta.url);
  await mkdir(output, { recursive: true });
  await writeFile(new URL('products.fallback.json', output), JSON.stringify(j));
  console.log(`✓ fallback refreshed: ${j.products.length} products`);
} catch (e) {
  // Exit code stays 0 — build must succeed even if the CDN isn't set up yet
  console.warn('⚠ fallback NOT refreshed, keeping committed copy:', e.message);
}
