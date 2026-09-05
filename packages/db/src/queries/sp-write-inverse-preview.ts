import { createHash, randomUUID } from 'node:crypto';
import {
  SpWriteActor, SpWriteInversePreviewRequest, SpWritePreview,
} from '@wizard-ads/shared/sp-write-application';
import {
  SpWriteAction, SpWritePlan, orderSpWriteActions, serializeSpWriteActionFingerprint,
  serializeSpWritePlanFingerprint, spWritePlanBinding, verifySpWriteInversePair,
  verifySpWritePlanFingerprints,
} from '@wizard-ads/shared/sp-writes';
import type { DbHandle } from '../client.js';
import { SpWriteApplicationError } from './sp-write-errors.js';
import { readSpWriteOperation } from './sp-write-operation-read.js';
import { createSpWriteStagingLedger } from './sp-write-persistence.js';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const hasher = { algorithm: 'sha256' as const, digest };

/** The full original plan must be observed and still current before an inverse is offered. */
export async function previewSpWriteInverse(
  handle: Pick<DbHandle, 'sql'>, rawActor: SpWriteActor, rawRequest: SpWriteInversePreviewRequest,
): Promise<SpWritePreview> {
  const actor = SpWriteActor.parse(rawActor);
  const request = SpWriteInversePreviewRequest.parse(rawRequest);
  const original = await readSpWriteOperation(handle, actor, { profileId: request.profileId, ...request.original });
  if (original.receipt.plan.direction !== 'forward' || original.original !== null) {
    throw new SpWriteApplicationError('unsupported_source');
  }
  const [source] = await handle.sql<{ artifact_text: string }[]>`
    select artifact_text from public.sp_write_plans where org_id = ${actor.orgId}::uuid
      and profile_id = ${request.profileId}::uuid and plan_id = ${request.original.planId}::uuid
  `;
  if (source === undefined) throw new SpWriteApplicationError('not_found');
  const forward = verifySpWritePlanFingerprints(JSON.parse(source.artifact_text), hasher);

  async function replay(): Promise<SpWritePreview | null> {
    const rows = await handle.sql<{ artifact_text: string }[]>`
      select artifact_text from public.sp_write_plans where org_id = ${actor.orgId}::uuid
        and profile_id = ${request.profileId}::uuid and plan_id = ${request.requestId}::uuid
    `;
    if (rows.length === 0) return null;
    const plan = verifySpWritePlanFingerprints(JSON.parse(rows[0]!.artifact_text), hasher);
    if (plan.source.kind !== 'inverse_execution'
      || plan.source.sourceExecutionId !== request.original.executionId
      || plan.source.sourcePlanId !== request.original.planId) throw new SpWriteApplicationError('identity_conflict');
    verifySpWriteInversePair(forward, plan, hasher);
    return SpWritePreview.parse({ plan, binding: spWritePlanBinding(plan), evidence: null });
  }
  const recorded = await replay();
  if (recorded !== null) return recorded;
  if (original.snapshot.accounting.observedRequested !== forward.counts.providerRows
    || !['succeeded', 'observed_after_ambiguous'].includes(original.snapshot.status)) {
    throw new SpWriteApplicationError('source_changed');
  }

  const expected = forward.actions.map((action) => {
    if (action.routeKey !== 'sp.v3.keywords.update' || action.changes.bid === undefined
      || Object.keys(action.changes).length !== 1) throw new SpWriteApplicationError('unsupported_source');
    return { keyword_id: action.entity.keywordId, amount: action.changes.bid.requested.amount };
  });
  const [mirror] = await handle.sql<{ matches: number; now: string; expires: string }[]>`
    select count(*)::int as matches, app.sp_write_instant(clock_timestamp()) as now,
      app.sp_write_instant(clock_timestamp() + interval '15 minutes') as expires
    from jsonb_to_recordset(${JSON.stringify(expected)}::text::jsonb) as expected(keyword_id text, amount text)
    join public.keywords keyword on keyword.org_id = ${actor.orgId}::uuid
      and keyword.profile_id = ${request.profileId}::uuid and keyword.amazon_id = expected.keyword_id
      and keyword.bid = expected.amount::numeric and keyword.ad_product = 'SP'
      and keyword.deleted_at is null and keyword.state in ('enabled','paused')
    join public.ad_profiles profile on profile.org_id = keyword.org_id and profile.id = keyword.profile_id
    join public.ads_connections connection on connection.org_id = profile.org_id and connection.id = profile.connection_id
    where profile.sync_enabled and connection.status = 'active'
      and profile.amazon_profile_id = ${forward.providerScope.amazonProfileId}
      and profile.connection_id = ${forward.providerScope.connectionId}::uuid
      and profile.region = ${forward.providerScope.region} and profile.currency_code = ${forward.providerScope.currencyCode}
  `;
  if (mirror?.matches !== forward.counts.providerRows) throw new SpWriteApplicationError('source_changed');
  const actions = orderSpWriteActions(forward.actions.map((action) => {
    if (action.routeKey !== 'sp.v3.keywords.update' || action.changes.bid === undefined) {
      throw new SpWriteApplicationError('unsupported_source');
    }
    const inverse = SpWriteAction.parse({
      actionId: randomUUID(), routeKey: action.routeKey, entity: action.entity,
      changes: { bid: { expected: action.changes.bid.requested, requested: action.changes.bid.expected } },
      sources: [{ kind: 'inverse_action', sourceActionId: action.actionId, changeKey: 'keyword.bid' }],
      fingerprint: '0'.repeat(64),
    });
    return { ...inverse, fingerprint: digest(serializeSpWriteActionFingerprint(inverse)) };
  }));
  const base = SpWritePlan.parse({
    ...forward, id: request.requestId, direction: 'inverse',
    source: { kind: 'inverse_execution', sourceExecutionId: request.original.executionId,
      sourcePlanId: forward.id, sourcePlanFingerprint: forward.fingerprint },
    actions, generatedAt: mirror.now, frozenAt: mirror.now, expiresAt: mirror.expires,
    fingerprint: '0'.repeat(64),
  });
  const plan = { ...base, fingerprint: digest(serializeSpWritePlanFingerprint(base)) };
  verifySpWriteInversePair(forward, plan, hasher);
  try { await createSpWriteStagingLedger(handle).recordPlan(plan); }
  catch {
    const winner = await replay();
    if (winner !== null) return winner;
    throw new SpWriteApplicationError('outcome_unknown');
  }
  return SpWritePreview.parse({ plan, binding: spWritePlanBinding(plan), evidence: null });
}
