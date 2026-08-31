export const CONTEXTUAL_NEGATIVE_ACTION_LIMIT = 500;
export const CONTEXTUAL_NEGATIVE_REQUEST_BYTE_LIMIT = 128 * 1024;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const FINGERPRINT = /^[0-9a-f]{64}$/u;
const DECISIONS = ['accepted', 'dismissed', 'proposed'] as const;

export interface ProposalExpectationInput {
  id: string;
  expectedFingerprint: string;
}

export interface ReviewScopeInput {
  profileId: string;
  marketplaceId: string;
  proposals: ProposalExpectationInput[];
}

export interface DecisionRequestInput extends ReviewScopeInput {
  decision: (typeof DECISIONS)[number];
  note: string | null;
}

export interface ExportRequestInput extends ReviewScopeInput {
  note: string;
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('request body must be a JSON object');
  }
  return value as Record<string, unknown>;
}

function rejectSpoofedActor(body: Record<string, unknown>): void {
  if (Object.hasOwn(body, 'orgId') || Object.hasOwn(body, 'actorId')) {
    throw new Error('orgId and actorId are derived from the authenticated request and must not be supplied');
  }
}

function scope(body: Record<string, unknown>): ReviewScopeInput {
  rejectSpoofedActor(body);
  if (typeof body['profileId'] !== 'string' || !UUID.test(body['profileId'])) {
    throw new Error('profileId must be a UUID');
  }
  if (typeof body['marketplaceId'] !== 'string' || body['marketplaceId'].trim().length === 0) {
    throw new Error('marketplaceId is required');
  }
  if (body['marketplaceId'].length > 128) throw new Error('marketplaceId is too long');
  if (!Array.isArray(body['proposals']) || body['proposals'].length === 0) {
    throw new Error('proposals must be a non-empty explicit selection');
  }
  if (body['proposals'].length > CONTEXTUAL_NEGATIVE_ACTION_LIMIT) {
    throw new Error(`proposals may contain at most ${CONTEXTUAL_NEGATIVE_ACTION_LIMIT} rows`);
  }
  const seen = new Set<string>();
  const proposals = body['proposals'].map((value, index) => {
    const proposal = object(value);
    const id = proposal['id'];
    const expectedFingerprint = proposal['expectedFingerprint'];
    if (typeof id !== 'string' || !UUID.test(id)) {
      throw new Error(`proposal ${index} id must be a UUID`);
    }
    if (seen.has(id)) throw new Error(`proposal ${id} is duplicated`);
    seen.add(id);
    if (typeof expectedFingerprint !== 'string' || !FINGERPRINT.test(expectedFingerprint)) {
      throw new Error(`proposal ${id} has an invalid review fingerprint`);
    }
    return { id, expectedFingerprint };
  });
  return {
    profileId: body['profileId'],
    marketplaceId: body['marketplaceId'].trim(),
    proposals,
  };
}

function optionalNote(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new Error('note must be text');
  const note = value.trim();
  if (note.length > 4000) throw new Error('note is too long');
  return note || null;
}

export function parseDecisionRequest(value: unknown): DecisionRequestInput {
  const body = object(value);
  const parsedScope = scope(body);
  if (typeof body['decision'] !== 'string' || !(DECISIONS as readonly string[]).includes(body['decision'])) {
    throw new Error(`decision must be one of: ${DECISIONS.join(', ')}`);
  }
  const decision = body['decision'] as DecisionRequestInput['decision'];
  const note = optionalNote(body['note']);
  if (decision === 'dismissed' && note === null) throw new Error('a dismissal needs a note');
  return { ...parsedScope, decision, note };
}

export function parseExportRequest(value: unknown): ExportRequestInput {
  const body = object(value);
  if (body['confirmed'] !== true) throw new Error('confirm “Yes, create evidence files” before exporting');
  const parsedScope = scope(body);
  const note = optionalNote(body['note']);
  if (note === null) throw new Error('an export needs a note');
  return { ...parsedScope, note };
}

export function parseExportFormat(value: string | null): 'csv' | 'json' {
  if (value === 'csv' || value === 'json') return value;
  throw new Error('format must be csv or json');
}

/** Read and decode JSON without allowing an unbounded body into memory. */
export async function readBoundedReviewJson(
  request: Request,
  limit = CONTEXTUAL_NEGATIVE_REQUEST_BYTE_LIMIT,
): Promise<unknown> {
  const declared = request.headers.get('content-length');
  if (declared !== null) {
    const bytes = Number(declared);
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('invalid content-length');
    if (bytes > limit) throw new Error(`request body exceeds ${limit} bytes`);
  }
  if (request.body === null) throw new SyntaxError('request body is empty');

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > limit) {
        await reader.cancel();
        throw new Error(`request body exceeds ${limit} bytes`);
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new SyntaxError('request body is not valid UTF-8');
  }
  return JSON.parse(text) as unknown;
}
