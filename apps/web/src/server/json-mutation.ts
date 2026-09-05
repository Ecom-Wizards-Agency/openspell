import { authOrigin } from '../auth/origin';

const MAX_BODY_BYTES = 16_384;

export class JsonMutationError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}

export async function readJsonMutation(request: Request): Promise<unknown> {
  if (request.headers.get('origin') !== authOrigin()) throw new JsonMutationError(403, 'origin_refused');
  if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
    throw new JsonMutationError(415, 'json_required');
  }
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_BODY_BYTES)) {
    throw new JsonMutationError(413, 'request_too_large');
  }
  if (request.body === null) throw new JsonMutationError(400, 'invalid_request');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new JsonMutationError(413, 'request_too_large');
      }
      chunks.push(chunk.value);
    }
  } finally { reader.releaseLock(); }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } catch { throw new JsonMutationError(400, 'invalid_request'); }
}
