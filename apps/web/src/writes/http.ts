import type { RequestDatabase } from '@wizard-ads/db';
import { SpWriteApplicationError } from '@wizard-ads/db/sp-write-application';
import { authOrigin } from '../auth/origin';
import { requireCapability } from '../server/org-role';
import { errorResponse, openWebDatabase, requestActor, RequestAuthError, type RequestActor } from '../server/request-context';

const MAX_BODY_BYTES = 16_384;

class WriteHttpError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}

async function readBody(request: Request): Promise<unknown> {
  if (request.headers.get('origin') !== authOrigin()) throw new WriteHttpError(403, 'origin_refused');
  if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
    throw new WriteHttpError(415, 'json_required');
  }
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_BODY_BYTES)) {
    throw new WriteHttpError(413, 'request_too_large');
  }
  if (request.body === null) throw new WriteHttpError(400, 'invalid_request');
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
        throw new WriteHttpError(413, 'request_too_large');
      }
      chunks.push(chunk.value);
    }
  } finally { reader.releaseLock(); }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } catch { throw new WriteHttpError(400, 'invalid_request'); }
}

function failure(error: unknown): Response {
  if (error instanceof RequestAuthError) return errorResponse(error);
  if (error instanceof WriteHttpError) return Response.json({ code: error.code }, { status: error.status });
  if (error instanceof SpWriteApplicationError) {
    const status = { not_found: 404, invalid_request: 400, unsupported_source: 422,
      source_changed: 409, identity_conflict: 409, authorization_refused: 403, outcome_unknown: 503 }[error.code];
    return Response.json({ code: error.code }, { status });
  }
  // A database error may follow a commit. This response never asserts no change.
  return Response.json({ code: 'outcome_unknown' }, { status: 503 });
}

/** Transport owns authentication and parsing; the application owns admission. */
export async function handleSpWriteRequest<T>(
  request: Request,
  schema: { safeParse(input: unknown): { success: true; data: T } | { success: false } },
  operation: (database: RequestDatabase, actor: RequestActor, input: T) => Promise<unknown>,
): Promise<Response> {
  let database: RequestDatabase | undefined;
  let response: Response;
  try {
    const actor = await requestActor(request.headers);
    database = openWebDatabase();
    await requireCapability(database, actor, 'applyAmazonChanges');
    const params = new URL(request.url).searchParams;
    if (request.method === 'GET' && [...params.keys()].length !== new Set(params.keys()).size) {
      throw new WriteHttpError(400, 'invalid_request');
    }
    const input: unknown = request.method === 'GET' ? Object.fromEntries(params) : await readBody(request);
    const parsed = schema.safeParse(input);
    if (!parsed.success) throw new WriteHttpError(400, 'invalid_request');
    const result = await operation(database, actor, parsed.data);
    response = Response.json(result);
  } catch (error) { response = failure(error); }
  finally { await database?.close().catch(() => undefined); }
  response.headers.set('cache-control', 'no-store');
  return response;
}
