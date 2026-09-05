import type { RequestDatabase } from '@wizard-ads/db';
import { SpWriteApplicationError } from '@wizard-ads/db/sp-write-application';
import { authOrigin } from '../auth/origin';
import { JsonMutationError } from './json-mutation';
import { requireCapability } from './org-role';
import { errorResponse, openWebDatabase, requestActor, RequestAuthError, type RequestActor } from './request-context';

/** Cookie-authenticated operator management only. An MCP bearer never establishes this actor. */
export async function handleMcpKeyMutation(
  request: Request,
  operation: (database: RequestDatabase, actor: RequestActor) => Promise<Response>,
): Promise<Response> {
  let database: RequestDatabase | undefined;
  let response: Response;
  try {
    const actor = await requestActor(request.headers);
    if (request.headers.get('origin') !== authOrigin()) throw new JsonMutationError(403, 'origin_refused');
    database = openWebDatabase();
    await requireCapability(database, actor, 'manageConnection');
    response = await operation(database, actor);
  } catch (error) {
    if (error instanceof RequestAuthError) response = errorResponse(error);
    else if (error instanceof JsonMutationError) response = Response.json({ code: error.code }, { status: error.status });
    else if (error instanceof SpWriteApplicationError) {
      const status = { not_found: 404, invalid_request: 400, unsupported_source: 422,
        source_changed: 409, identity_conflict: 409, authorization_refused: 403, outcome_unknown: 503 }[error.code];
      response = Response.json({ code: error.code }, { status });
    } else response = Response.json({ code: 'outcome_unknown' }, { status: 503 });
  } finally { await database?.close().catch(() => undefined); }
  response.headers.set('cache-control', 'no-store');
  return response;
}
