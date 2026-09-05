import { RecommendationRevisionError, reviseRecommendation, type RequestDatabase } from '@wizard-ads/db';
import { RecommendationRevisionRequest } from '@wizard-ads/shared/recommendation-revisions';
import { JsonMutationError, readJsonMutation } from '../../../../src/server/json-mutation';
import { requireCapability } from '../../../../src/server/org-role';
import { errorResponse, openWebDatabase, requestActor, RequestAuthError } from '../../../../src/server/request-context';

export const runtime = 'nodejs';

/** Edit a draft proposal; Amazon approval remains a separate operation. */
export async function POST(request: Request): Promise<Response> {
  let database: RequestDatabase | undefined;
  let response: Response;
  try {
    const actor = await requestActor(request.headers);
    database = openWebDatabase();
    await requireCapability(database, actor, 'editTargets');
    const parsed = RecommendationRevisionRequest.safeParse(await readJsonMutation(request));
    if (!parsed.success) throw new JsonMutationError(400, 'invalid_request');
    const receipt = await reviseRecommendation(database, actor, parsed.data);
    response = Response.json(receipt);
  } catch (error) {
    if (error instanceof RequestAuthError) response = errorResponse(error);
    else if (error instanceof JsonMutationError) response = Response.json({ code: error.code }, { status: error.status });
    else if (error instanceof RecommendationRevisionError) {
      response = Response.json({ code: error.code }, {
        status: { not_found: 404, forbidden: 403, conflict: 409, invalid_request: 400, unavailable: 503 }[error.code],
      });
    } else response = Response.json({ code: 'unavailable' }, { status: 503 });
  } finally { await database?.close().catch(() => undefined); }
  response.headers.set('cache-control', 'no-store');
  return response;
}
