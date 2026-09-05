import { SpWriteActor } from '@wizard-ads/shared/sp-write-application';
import {
  RecommendationRevisionReceipt, RecommendationRevisionRequest, RecommendationRevisionSelection,
} from '@wizard-ads/shared/recommendation-revisions';
import { Uuid } from '@wizard-ads/shared';
import type { DbHandle } from '../client.js';
import { withAuthenticatedActor } from './authenticated-actor.js';

export class RecommendationRevisionError extends Error {
  constructor(readonly code: 'not_found' | 'forbidden' | 'conflict' | 'invalid_request' | 'unavailable') {
    super(`recommendation revision ${code}`);
  }
}

function revisionError(error: unknown): RecommendationRevisionError {
  if (error instanceof RecommendationRevisionError) return error;
  const code = error !== null && typeof error === 'object' && 'code' in error ? error.code : null;
  if (code === '42501') return new RecommendationRevisionError('forbidden');
  if (code === 'P0002') return new RecommendationRevisionError('not_found');
  if (code === '23505' || code === '40001' || code === '55000') return new RecommendationRevisionError('conflict');
  if (code === '22023' || code === '22P02') return new RecommendationRevisionError('invalid_request');
  return new RecommendationRevisionError('unavailable');
}

/** Actor comes from the authenticated server session. A retry returns the historical edit. */
export async function reviseRecommendation(
  handle: Pick<DbHandle, 'sql'>, rawActor: SpWriteActor, rawRequest: RecommendationRevisionRequest,
): Promise<RecommendationRevisionReceipt> {
  try {
    const actorResult = SpWriteActor.safeParse(rawActor);
    const requestResult = RecommendationRevisionRequest.safeParse(rawRequest);
    if (!actorResult.success || !requestResult.success) throw new RecommendationRevisionError('invalid_request');
    const actor = actorResult.data;
    const request = requestResult.data;
    return await withAuthenticatedActor(handle, actor, async (sql) => {
      const rows = await sql<{ receipt: unknown }[]>`
        select app.revise_recommendation_v1(${actor.orgId}::uuid, ${JSON.stringify(request)}::text) as receipt
      `;
      if (rows.length !== 1) throw new RecommendationRevisionError('unavailable');
      return RecommendationRevisionReceipt.parse(rows[0]!.receipt);
    });
  } catch (error) { throw revisionError(error); }
}

/** Exact reviewed selection, or the legacy unchanged-base selection when omitted. */
export function recommendationRevisionSelection(
  rawIds: readonly string[], rawRefs?: RecommendationRevisionSelection,
): { ids: string[]; refs: RecommendationRevisionSelection | null } {
  const ids = Uuid.transform((id) => id.toLowerCase()).array().max(20_000).parse(rawIds);
  const selected = new Set(ids);
  if (selected.size !== ids.length) throw new RecommendationRevisionError('invalid_request');
  const refs = rawRefs === undefined ? null : RecommendationRevisionSelection.parse(rawRefs);
  if (refs !== null && (refs.length !== ids.length || refs.some((ref) => !selected.has(ref.recommendationId)))) {
    throw new RecommendationRevisionError('invalid_request');
  }
  return { ids, refs };
}
