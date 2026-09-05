import type { RequestDatabase } from '@wizard-ads/db';
import { SpWriteApplicationError } from '@wizard-ads/db/sp-write-application';
import { JsonMutationError, readJsonMutation } from '../server/json-mutation';
import { requireCapability } from '../server/org-role';
import { errorResponse, openWebDatabase, requestActor, RequestAuthError, type RequestActor } from '../server/request-context';


function failure(error: unknown): Response {
  if (error instanceof RequestAuthError) return errorResponse(error);
  if (error instanceof JsonMutationError) return Response.json({ code: error.code }, { status: error.status });
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
      throw new JsonMutationError(400, 'invalid_request');
    }
    const input: unknown = request.method === 'GET' ? Object.fromEntries(params) : await readJsonMutation(request);
    const parsed = schema.safeParse(input);
    if (!parsed.success) throw new JsonMutationError(400, 'invalid_request');
    const result = await operation(database, actor, parsed.data);
    response = Response.json(result);
  } catch (error) { response = failure(error); }
  finally { await database?.close().catch(() => undefined); }
  response.headers.set('cache-control', 'no-store');
  return response;
}
