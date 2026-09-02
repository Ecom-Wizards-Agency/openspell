export const OPTIMIZER_PREVIEW_BODY_MAX_BYTES = 512 * 1024;
export const OPTIMIZER_PREVIEW_CAMPAIGN_MAX = 10_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type OptimizerPreviewRequest = {
  profileId: string;
  clientRequestId: string;
  scope:
    | { mode: 'all' }
    | { mode: 'selected'; campaignIds: string[] };
};

export class OptimizerPreviewHttpError extends Error {
  constructor(message: string, readonly status: 400 | 409 | 413 = 400) {
    super(message);
    this.name = 'OptimizerPreviewHttpError';
  }
}

/** Read JSON without first allowing an unbounded request body into memory. */
export async function readOptimizerPreviewRequest(request: Request): Promise<OptimizerPreviewRequest> {
  const contentLength = request.headers.get('content-length');
  if (contentLength !== null) {
    const declared = Number(contentLength);
    if (!Number.isSafeInteger(declared) || declared < 0) {
      throw new OptimizerPreviewHttpError('Invalid Content-Length');
    }
    if (declared > OPTIMIZER_PREVIEW_BODY_MAX_BYTES) {
      throw new OptimizerPreviewHttpError('Preview request body is too large', 413);
    }
  }

  const body = request.body;
  if (body === null) throw new OptimizerPreviewHttpError('Preview request body is required');
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0;
  let text = '';
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > OPTIMIZER_PREVIEW_BODY_MAX_BYTES) {
        await reader.cancel('preview request body limit exceeded').catch(() => undefined);
        throw new OptimizerPreviewHttpError('Preview request body is too large', 413);
      }
      text += decoder.decode(part.value, { stream: true });
    }
    text += decoder.decode();
  } catch (error) {
    if (error instanceof OptimizerPreviewHttpError) throw error;
    throw new OptimizerPreviewHttpError('Malformed JSON request');
  } finally {
    reader.releaseLock();
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new OptimizerPreviewHttpError('Malformed JSON request');
  }
  return parseOptimizerPreviewRequest(value);
}

export function parseOptimizerPreviewRequest(value: unknown): OptimizerPreviewRequest {
  if (!isRecord(value)) throw new OptimizerPreviewHttpError('Preview request must be an object');
  const profileId = optimizerPreviewUuid(value['profileId'], 'profileId');
  const clientRequestId = optimizerPreviewUuid(value['clientRequestId'], 'clientRequestId');
  const scope = value['scope'];
  if (!isRecord(scope)) throw new OptimizerPreviewHttpError('scope must be an object');

  if (scope['mode'] === 'all') {
    if (scope['campaignIds'] !== undefined) {
      throw new OptimizerPreviewHttpError('All scope must not include campaignIds');
    }
    return { profileId, clientRequestId, scope: { mode: 'all' } };
  }
  if (scope['mode'] !== 'selected') {
    throw new OptimizerPreviewHttpError('scope.mode must be all or selected');
  }
  const offered = scope['campaignIds'];
  if (!Array.isArray(offered)) {
    throw new OptimizerPreviewHttpError('Selected scope requires campaignIds');
  }
  if (offered.length === 0) {
    throw new OptimizerPreviewHttpError('Select at least one campaign');
  }
  if (offered.length > OPTIMIZER_PREVIEW_CAMPAIGN_MAX) {
    throw new OptimizerPreviewHttpError(
      `Selected scope cannot exceed ${OPTIMIZER_PREVIEW_CAMPAIGN_MAX} campaigns`,
      413,
    );
  }

  const campaignIds: string[] = [];
  const seen = new Set<string>();
  for (const campaignId of offered) {
    if (
      typeof campaignId !== 'string' ||
      campaignId.length === 0 ||
      campaignId !== campaignId.trim()
    ) {
      throw new OptimizerPreviewHttpError('campaignIds must contain non-empty canonical strings');
    }
    if (seen.has(campaignId)) {
      throw new OptimizerPreviewHttpError('campaignIds must be unique');
    }
    seen.add(campaignId);
    campaignIds.push(campaignId);
  }
  return { profileId, clientRequestId, scope: { mode: 'selected', campaignIds } };
}

export function optimizerPreviewUuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new OptimizerPreviewHttpError(`${field} must be a UUID`);
  }
  return value.toLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
