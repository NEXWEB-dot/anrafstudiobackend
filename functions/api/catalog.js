export async function onRequestGet({ env }) {
  const object = await env.PUBLIC.get('catalog/products.json');
  if (!object) return Response.json({ error: 'CATALOG_UNAVAILABLE' }, { status: 503 });
  return new Response(await object.text(), { headers: {
    'Content-Type': 'application/json', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  } });
}
