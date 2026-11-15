/** Read a JSON body with a byte ceiling before buffering it in Worker memory. */
export async function boundedJson(req: Request, maxBytes = 8 * 1024 * 1024): Promise<unknown> {
  if (Number(req.headers.get('content-length')) > maxBytes) throw new Error('request too large');
  const reader = req.body?.getReader();
  if (!reader) throw new Error('empty body');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel(); throw new Error('request too large'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder().decode(bytes));
}
