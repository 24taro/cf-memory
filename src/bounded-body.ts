export const MAX_REQUEST_BODY_BYTES = 8 * 1024 * 1024;

export class RequestBodyTooLargeError extends Error {
  constructor() {
    super('request too large');
  }
}

/** Read a body with a byte ceiling, independently of the declared length. */
export async function boundedBytes(req: Request, maxBytes: number): Promise<Uint8Array<ArrayBuffer>> {
  if (Number(req.headers.get('content-length')) > maxBytes) throw new RequestBodyTooLargeError();
  const reader = req.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        // Reject promptly even if an upstream cancellation takes time.
        void reader.cancel().catch(() => {});
        throw new RequestBodyTooLargeError();
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

export async function boundedJson(req: Request, maxBytes = MAX_REQUEST_BODY_BYTES): Promise<unknown> {
  return JSON.parse(new TextDecoder().decode(await boundedBytes(req, maxBytes)));
}
