// functions/api/admin/upload.js — image upload to R2 via binding (no presigned URLs)
// The BROWSER produces WebP thumbnails via canvas before uploading.

const json = (o, s = 200) =>
  new Response(JSON.stringify(o), {
    status: s,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

const ALLOWED_TYPES = new Set(['image/webp', 'image/jpeg', 'image/png']);
const MAX_SIZE = 5 * 1024 * 1024; // 5 MB
const MAX_THUMB = 500 * 1024;      // 500 KB

/** Verify magic bytes — NEVER trust only the MIME type header. No SVG, ever. */
function checkMagic(bytes, mime) {
  const b = new Uint8Array(bytes.slice(0, 12));
  if (mime === 'image/jpeg')
    return b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  if (mime === 'image/png')
    return b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
  if (mime === 'image/webp') {
    const riff = b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46;
    const webp = b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50;
    return riff && webp;
  }
  return false;
}

const extFor = (mime) =>
  ({ 'image/webp': 'webp', 'image/jpeg': 'jpg', 'image/png': 'png' }[mime]);

export async function onRequestPost({ request, env, data }) {
  let formData;
  try { formData = await request.formData(); } catch { return json({ error: 'bad_form' }, 400); }

  const file = formData.get('file');
  const thumb = formData.get('thumb');

  if (!file || !(file instanceof File)) return json({ error: 'missing_file' }, 400);

  const mime = file.type;
  if (!ALLOWED_TYPES.has(mime)) return json({ error: 'unsupported_type' }, 415);
  if (file.size > MAX_SIZE) return json({ error: 'file_too_large' }, 413);

  const fileBytes = await file.arrayBuffer();
  if (!checkMagic(fileBytes, mime)) return json({ error: 'invalid_magic_bytes' }, 415);

  const uuid = crypto.randomUUID();
  const fileExt = extFor(mime);
  const r2Key = `img/${uuid}.${fileExt}`;

  // Never overwrite an existing key (new upload = new UUID = new immutable key)
  const existing = await env.PUBLIC.head(r2Key);
  if (existing) return json({ error: 'key_collision' }, 409); // astronomically unlikely

  await env.PUBLIC.put(r2Key, fileBytes, {
    httpMetadata: {
      contentType: mime,
      cacheControl: 'public, max-age=31536000, immutable',
    },
  });

  const url = `${env.PUBLIC_CDN_ORIGIN}/${r2Key}`;
  let thumbR2Key = null;
  let thumbUrl = null;

  // Thumbnail (optional, produced by browser canvas)
  if (thumb instanceof File && thumb.size > 0 && thumb.size <= MAX_THUMB) {
    const thumbBytes = await thumb.arrayBuffer();
    const thumbMime = thumb.type;
    if (ALLOWED_TYPES.has(thumbMime) && checkMagic(thumbBytes, thumbMime)) {
      thumbR2Key = `img/${uuid}-t.${extFor(thumbMime)}`;
      await env.PUBLIC.put(thumbR2Key, thumbBytes, {
        httpMetadata: {
          contentType: thumbMime,
          cacheControl: 'public, max-age=31536000, immutable',
        },
      });
      thumbUrl = `${env.PUBLIC_CDN_ORIGIN}/${thumbR2Key}`;
    }
  }

  console.log(JSON.stringify({
    t: new Date().toISOString(), admin: data.admin,
    action: 'upload_image', r2Key,
  }));

  return json({ r2_key: r2Key, url, thumb_r2_key: thumbR2Key, thumb_url: thumbUrl });
}
