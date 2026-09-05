import { createHash, randomUUID } from 'node:crypto';
import {
  McpBidPreviewRequest, serializeMcpBidPreviewRequest,
} from '@wizard-ads/shared/mcp-writes';
import { McpBidProposalArtifact, serializeMcpBidProposalArtifact } from '@wizard-ads/shared/sp-write-preview-evidence';
import {
  SpWriteAction, SpWritePlan, serializeSpWriteActionFingerprint, serializeSpWritePlanFingerprint,
  type McpWriteDelegation,
} from '@wizard-ads/shared/sp-writes';
import type { SpWriteActor } from '@wizard-ads/shared/sp-write-application';
import type { DbHandle } from '../client.js';
import { issueMcpWriteDelegation } from '../queries/mcp-writes.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const ZERO = '0'.repeat(64);

export interface SyntheticMcpSource {
  delegation: McpWriteDelegation;
  request: McpBidPreviewRequest;
  artifact: McpBidProposalArtifact;
  plan: SpWritePlan;
  batchCreatedBy: string;
  batchPreparedAt: string;
  omitSource: boolean;
}

/** Root-only disposable fixture. It proves source invariants, not MCP preparation or admission. */
export async function seedSyntheticMcpProposal(
  database: DbHandle, actor: SpWriteActor, profileId: string,
  mutate?: (source: SyntheticMcpSource) => void,
): Promise<SyntheticMcpSource> {
  const delegation = await issueMcpWriteDelegation(database, actor, {
    label: 'Synthetic proposal fixture', profileIds: [profileId],
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    limits: { action: 'keyword.bid', maximumRowsPerCall: 2, maximumRowsPerUtcDay: 3,
      maximumAbsoluteDeltaByCurrency: [{ amount: '0.3', currencyCode: 'USD' }], maximumRelativeDelta: '0.5' },
  }, { tokenHash: hash(randomUUID()), keyPrefix: 'wza_syntheti' });
  const [profile] = await database.sql<{ amazon_profile_id: string; connection_id: string }[]>`
    select amazon_profile_id, connection_id from public.ad_profiles where org_id = ${actor.orgId} and id = ${profileId}`;
  if (!profile) throw new Error('synthetic profile missing');
  const request = McpBidPreviewRequest.parse({ requestId: randomUUID(), profileId,
    source: { kind: 'keyword_proposals', note: 'Synthetic MCP proposal',
      rows: [{ keywordId: 'kw-1', expectedBid: '0.9', requestedBid: '0.8' }] } });
  if (request.source.kind !== 'keyword_proposals') throw new Error('synthetic proposal missing');
  const at = new Date().toISOString();
  const artifact = McpBidProposalArtifact.parse({ schemaVersion: 'openspell.mcp-bid-proposal.v1',
    orgId: actor.orgId, profileId, applyBatchId: randomUUID(), requestId: request.requestId,
    keyId: delegation.keyId, issuerUserId: actor.userId, delegationVersionId: delegation.versionId,
    preparedAt: at, note: request.source.note,
    rows: request.source.rows.map((row) => ({ ...row, applyRowId: randomUUID() })) });
  const action = SpWriteAction.parse({ actionId: randomUUID(), routeKey: 'sp.v3.keywords.update',
    entity: { keywordId: 'kw-1' }, sources: [{ kind: 'apply_row', applyRowId: artifact.rows[0]!.applyRowId, changeKey: 'keyword.bid' }],
    changes: { bid: { expected: { amount: '0.9', currencyCode: 'USD' }, requested: { amount: '0.8', currencyCode: 'USD' } } },
    fingerprint: ZERO });
  const plan = SpWritePlan.parse({ schemaVersion: 'openspell.sp-write-plan.v2', id: randomUUID(),
    orgId: actor.orgId, profileId, providerScope: { amazonProfileId: profile.amazon_profile_id,
      connectionId: profile.connection_id, region: 'NA', marketplaceId: 'ATVPDKIKX0DER', currencyCode: 'USD', apiDialect: 'sp_v3' },
    direction: 'forward', source: { kind: 'apply_batch', applyBatchId: artifact.applyBatchId,
      guardrailSnapshotFingerprint: 'a'.repeat(64), provenanceSnapshotFingerprint: 'b'.repeat(64) },
    generatedAt: at, frozenAt: at, expiresAt: new Date(Date.now() + 600_000).toISOString(), actions: [action],
    counts: { logicalChanges: 1, providerRows: 1, uniqueEntities: 1,
      byRoute: { 'sp.v3.campaigns.update': 0, 'sp.v3.ad_groups.update': 0, 'sp.v3.keywords.update': 1,
        'sp.v3.targets.update': 0, 'sp.v3.product_ads.update': 0 } }, fingerprint: ZERO });
  const source: SyntheticMcpSource = { delegation, request, artifact, plan,
    batchCreatedBy: actor.userId, batchPreparedAt: at, omitSource: false };
  mutate?.(source);
  for (const item of plan.actions) item.fingerprint = hash(serializeSpWriteActionFingerprint(item));
  plan.fingerprint = hash(serializeSpWritePlanFingerprint(plan));
  const artifactText = serializeMcpBidProposalArtifact(artifact);
  const artifactHash = hash(artifactText);
  const requestText = JSON.stringify(request);
  const requestPreimage = serializeMcpBidPreviewRequest(request);
  await database.sql.begin(async (sql) => {
    await sql`insert into mcp.write_previews
      (plan_id, org_id, profile_id, key_id, delegation_version_id, request_id, request_text,
        request, request_preimage, request_fingerprint, prepared_at)
      values (${plan.id}, ${actor.orgId}, ${profileId}, ${delegation.keyId}, ${delegation.versionId},
        ${request.requestId}, ${requestText}, ${requestText}::jsonb, ${requestPreimage}, ${hash(requestPreimage)}, ${at})`;
    await sql`insert into public.apply_batches
      (id, org_id, profile_id, tag, opt_group, lever, note, source_kind, artifact_sha256,
        exported_proposals, reversible_rows, unsupported_rows, created_by, exported_at)
      values (${artifact.applyBatchId}, ${actor.orgId}, ${profileId}, ${artifact.applyBatchId}, 'synthetic', 'bid',
        ${artifact.note}, 'mcp_keyword_proposals', ${artifactHash}, 0, ${artifact.rows.length}, 0,
        ${source.batchCreatedBy}, ${source.batchPreparedAt})`;
    for (const row of artifact.rows) await sql`insert into public.apply_rows
      (id, batch_id, org_id, profile_id, entity_type, entity_id, entity_name, field, old_value, new_value)
      values (${row.applyRowId}, ${artifact.applyBatchId}, ${actor.orgId}, ${profileId}, 'keyword', ${row.keywordId},
        'Synthetic proposal keyword', 'bid', ${JSON.stringify(row.expectedBid)}::jsonb, ${JSON.stringify(row.requestedBid)}::jsonb)`;
    if (!source.omitSource) await sql`insert into mcp.bid_proposal_sources
      (batch_id, org_id, profile_id, plan_id, artifact_text, artifact, artifact_sha256)
      values (${artifact.applyBatchId}, ${actor.orgId}, ${profileId}, ${plan.id}, ${artifactText}, ${artifactText}::jsonb, ${artifactHash})`;
    await sql`select app.record_sp_write_plan(${JSON.stringify(plan)}, ${serializeSpWritePlanFingerprint(plan)},
      ${JSON.stringify(plan.actions.map((item) => ({ artifactText: JSON.stringify(item),
        fingerprintPreimage: serializeSpWriteActionFingerprint(item) })))}::jsonb)`;
  });
  return source;
}
