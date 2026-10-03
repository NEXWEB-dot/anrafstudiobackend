export async function readJSON(request, maxBytes = 20000) {
  const reader = request.body?.getReader();
  if (!reader) throw Object.assign(new Error('bad_json'), { status: 400 });
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) {
        await reader.cancel();
        throw Object.assign(new Error('too_large'), { status: 413 });
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let value;
  try { value = JSON.parse(new TextDecoder().decode(bytes)); } catch {
    throw Object.assign(new Error('bad_json'), { status: 400 });
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw Object.assign(new Error('BAD_INPUT'), { status: 400 });
  }
  return value;
}
