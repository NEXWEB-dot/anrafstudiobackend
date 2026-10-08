import {getSanityCatalog} from '../../shared/sanity.js';

/** Hash the entire representation so changes to any product field invalidate it. */
async function makeEtag(catalog) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(catalog)));
  return `"${Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('')}"`;
}

export async function onRequestGet({env, request}) {
  try {
    const catalog = await getSanityCatalog(env);
    const tag = await makeEtag(catalog);
    const remaining = Math.max(0, Math.min(60, 300 - Math.ceil((Date.now() - Date.parse(catalog.generated_at)) / 1000)));
    const headers = {'ETag': tag, 'Cache-Control': `public, max-age=${remaining}, must-revalidate`,
      'Vary': 'Accept-Encoding', 'X-Content-Type-Options': 'nosniff'};

    // Browser already has this exact version → return 304 (headers only, no body)
    if (request?.headers.get('If-None-Match')?.split(',').some(value => value.trim().replace(/^W\//, '') === tag || value.trim() === '*')) {
      return new Response(null, {
        status: 304,
        headers,
      });
    }

    return Response.json(catalog, {
      headers,
    });
  } catch {
    return Response.json(
      {error: 'CATALOG_UNAVAILABLE'},
      {status: 503, headers: {'Cache-Control': 'no-store'}},
    );
  }
}
