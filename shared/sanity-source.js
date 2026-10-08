// Shared public catalog contract. Keep frontend and backend copies identical (verified by tests).
// All visitors share stable CDN query URLs. No token or timestamp in public queries.
export const PRODUCT_ID = /^(?!drafts\.)(?!versions\.)[a-zA-Z0-9_-][a-zA-Z0-9_.-]{0,127}$/;



const query = /* groq */ `*[_type == "product" && isActive == true] | order(sortOrder asc, _id asc){
  "id": _id, "slug": slug.current, name, description, price, discountPercent, sizes, filters,
  "compare_at_price": compareAtPrice, category, "in_stock": availability == "in-stock",
  "is_active": isActive, "images": images[]{_key, alt, "asset": asset._ref}
}`;

export function sanityURL(env) {
  const project = env.SANITY_PROJECT_ID || 'm7hktaor';
  const dataset = env.SANITY_DATASET || 'production';
  if (!/^[a-z0-9]+$/.test(project) || !/^[a-z0-9_-]+$/.test(dataset)) throw new Error('Invalid Sanity configuration');
  const url = new URL(`https://${project}.apicdn.sanity.io/v2026-10-08/data/query/${dataset}`);
  url.searchParams.set('query', query);
  url.searchParams.set('perspective', 'published');
  url.searchParams.set('returnQuery', 'false');
  return url;
}

function imageURL(ref, env, width) {
  const match = /^image-([a-zA-Z0-9]+)-(\d+x\d+)-(jpg|jpeg|png|webp|gif|avif)$/.exec(ref || '');
  if (!match) return '';
  return `https://cdn.sanity.io/images/${env.SANITY_PROJECT_ID || 'm7hktaor'}/${env.SANITY_DATASET || 'production'}/${match[1]}-${match[2]}.${match[3]}?w=${width}&fit=max&auto=format&q=80`;
}

export function normalizeSanity(result, env) {
  if (!Array.isArray(result)) throw new Error('Invalid Sanity catalog');
  const products = result.map(p => {
    if (!p || typeof p.id !== 'string' || !PRODUCT_ID.test(p.id) ||
        typeof p.slug !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(p.slug) ||
        typeof p.name !== 'string' || !p.name.trim() || p.name.length > 200 ||
        typeof p.price !== 'number' || !Number.isFinite(p.price) || p.price < 1 || p.price > 10000000 ||
        Math.abs(p.price * 100 - Math.round(p.price * 100)) > 0.000001)
      throw new Error('Invalid Sanity product');
    const discount = p.discountPercent ?? 0;
    if (!Number.isInteger(discount) || discount < 0 || discount > 99) throw new Error('Invalid discount');
    const price = Math.round(Math.round(p.price * 100) * (100 - discount) / 100) / 100;
    if (price < 1) throw new Error('Invalid discounted price');
    const sizes = p.sizes ?? ['Small', 'Medium', 'Large', 'XL'];
    if (!Array.isArray(sizes) || sizes.some(s => !['Small', 'Medium', 'Large', 'XL'].includes(s))) throw new Error('Invalid sizes');
    const filters = p.filters?.length ? p.filters : (p.category ? [p.category] : []);
    if (!Array.isArray(filters) || filters.some(f => !['Embroidered', 'Lawn', 'Heritage', 'Ready to Wear'].includes(f))) throw new Error('Invalid filters');
    return {...p, price, compare_at_price: discount > 0 ? p.price : p.compare_at_price,
      discount_percent: discount, sizes: [...new Set(sizes)], filters: [...new Set(filters)],
      description: typeof p.description === 'string' ? p.description : '',
      in_stock: p.in_stock === true && sizes.length > 0, is_active: true, track_stock: false,
      images: (p.images || []).map(i => ({url: imageURL(i.asset, env, 1200), thumb: imageURL(i.asset, env, 480), alt: i.alt || p.name})).filter(i => i.url)};
  });
  if (new Set(products.map(p => p.id)).size !== products.length || new Set(products.map(p => p.slug)).size !== products.length)
    throw new Error('Duplicate Sanity product');
  return {count: products.length, version: 2, source: 'sanity', generated_at: new Date().toISOString(), products};
}
