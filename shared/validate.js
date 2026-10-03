// shared/validate.js — input validation for admin product saves
// Throws ValidationError (status 400) if validation fails.

export class ValidationError extends Error {
  constructor(msg) {
    super(msg);
    this.status = 400;
  }
}

const SLUG_RE = /^[a-z0-9-]{1,120}$/;

export function validateProduct(p, cdnOrigin) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) throw new ValidationError('Invalid product object');

  // slug
  if (!SLUG_RE.test(p.slug ?? ''))
    throw new ValidationError('slug must be lowercase letters, digits, and hyphens (1–120 chars)');

  // name
  const name = String(p.name ?? '').trim();
  if (name.length < 1 || name.length > 200)
    throw new ValidationError('name must be 1–200 characters');

  // description
  if (p.description != null && String(p.description).length > 5000)
    throw new ValidationError('description must be ≤ 5000 characters');

  // price
  const price = Number(p.price);
  if (p.price == null || p.price === '' || typeof p.price === 'boolean' || !Number.isFinite(price) || price < 0 || price > 9999999999.99 || !/^\d+(\.\d{1,2})?$/.test(String(price)))
    throw new ValidationError('price must be a non-negative number with at most 2 decimal places');

  // compare_at_price (optional)
  if (p.compare_at_price != null && p.compare_at_price !== '') {
    const cap = Number(p.compare_at_price);
    if (!Number.isFinite(cap) || cap < 0 || cap > 9999999999.99 || !/^\d+(\.\d{1,2})?$/.test(String(cap)))
      throw new ValidationError('compare_at_price must be a non-negative number with at most 2 decimal places');
  }

  // stock
  const stock = Number(p.stock ?? 0);
  if (!Number.isInteger(stock) || stock < 0 || stock > 2147483647)
    throw new ValidationError('stock must be a non-negative integer');

  // booleans
  for (const field of ['track_stock', 'in_stock', 'is_active']) {
    if (p[field] != null && typeof p[field] !== 'boolean')
      throw new ValidationError(`${field} must be a boolean`);
  }

  // images
  const images = p.images ?? [];
  if (!Array.isArray(images)) throw new ValidationError('images must be an array');
  if (images.length > 10) throw new ValidationError('at most 10 images per product');
  for (const img of images) {
    if (!img || typeof img !== 'object') throw new ValidationError('Invalid image');
    for (const [key, url] of [[img.r2_key, img.url], [img.thumb_r2_key, img.thumb_url]]) {
      if (key == null && url == null && key !== img.r2_key) continue;
      if (typeof key !== 'string' || !/^img\/[a-zA-Z0-9_-]+\.(webp|jpg|jpeg|png)$/.test(key))
        throw new ValidationError('Invalid image key');
      let expected;
      try {
        const origin = new URL(cdnOrigin);
        if (origin.protocol !== 'https:') throw new Error();
        expected = `${origin.origin}/${key}`;
      } catch { throw new ValidationError('Image CDN is not configured'); }
      if (url !== expected) throw new ValidationError('Image URL must match its CDN object key');
    }
  }

  // Assemble validated + normalised product
  return {
    id: p.id,
    slug: String(p.slug).trim(),
    name,
    description: p.description != null ? String(p.description).trim().slice(0, 5000) : null,
    price,
    compare_at_price: (p.compare_at_price != null && p.compare_at_price !== '')
      ? Number(p.compare_at_price) : null,
    category: p.category != null ? String(p.category).trim().slice(0, 100) : null,
    track_stock: !!p.track_stock,
    stock,
    in_stock: p.in_stock !== false,
    is_active: p.is_active !== false,
    sort_order: Number.isInteger(Number(p.sort_order)) ? Number(p.sort_order) : 0,
    images,
  };
}
