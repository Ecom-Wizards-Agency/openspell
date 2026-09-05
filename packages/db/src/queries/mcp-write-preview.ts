import { createHash, randomUUID } from 'node:crypto';
import { McpBidPreviewRequest, McpWriteCredential, serializeMcpBidPreviewRequest } from '@wizard-ads/shared/mcp-writes';
import { SpWritePreview } from '@wizard-ads/shared/sp-write-application';
import {
  McpBidProposalArtifact, SpMcpWritePreviewEvidenceV2, serializeMcpBidProposalArtifact,
  serializeSpWritePreviewGuardrails, serializeSpWritePreviewProvenance, verifyMcpWritePreviewEvidenceArtifacts,
} from '@wizard-ads/shared/sp-write-preview-evidence';
import {
  SpWriteAction, SpWritePlan, SpWriteProviderScope, serializeSpWriteActionFingerprint,
  serializeSpWritePlanFingerprint, spWritePlanBinding, verifyMcpWriteDelegationFingerprint,
} from '@wizard-ads/shared/sp-writes';
import type { DbHandle } from '../client.js';
import { SpWriteApplicationError } from './sp-write-errors.js';
import { loadSpWritePreviewEvidence } from './sp-write-preview-evidence.js';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const hasher = { algorithm: 'sha256' as const, digest };
const ZERO = '0'.repeat(64);

function refuse(error: unknown): never {
  if (error instanceof SpWriteApplicationError) throw error;
  const code = error !== null && typeof error === 'object' && 'code' in error ? error.code : null;
  if (code === '42501') throw new SpWriteApplicationError('authorization_refused');
  if (code === '55000' || code === 'P0002') throw new SpWriteApplicationError('source_changed');
  if (code === '23505') throw new SpWriteApplicationError('identity_conflict');
  if (code === '22023' || code === '22P02' || code === '22003') throw new SpWriteApplicationError('invalid_request');
  throw new SpWriteApplicationError('outcome_unknown');
}

/** Private source preparation. Admission and daily capacity belong to the MCP application facade. */
export async function prepareMcpKeywordBidPreview(
  handle: Pick<DbHandle, 'sql'>, rawCredential: McpWriteCredential, rawRequest: McpBidPreviewRequest,
) {
  const credential = McpWriteCredential.safeParse(rawCredential); const request = McpBidPreviewRequest.safeParse(rawRequest);
  if (!credential.success || !request.success) throw new SpWriteApplicationError('invalid_request');
  const c = credential.data; const r = request.data;
  if (r.source.kind !== 'keyword_proposals') throw new SpWriteApplicationError('unsupported_source');
  const proposals = r.source;
  async function context() {
    const rows = await handle.sql<{ value: { delegation: unknown; providerScope: unknown;
      profileGrantId: string; profileGrantVersion: string; now: string } }[]>`
      select app.mcp_bid_preview_context(${c.orgId},${c.keyId},${c.tokenHash},${r.profileId}) as value`;
    if (rows.length !== 1 || !rows[0]?.value) throw new SpWriteApplicationError('outcome_unknown');
    const value = rows[0].value;
    return { ...value, delegation: verifyMcpWriteDelegationFingerprint(value.delegation, hasher),
      providerScope: SpWriteProviderScope.parse(value.providerScope) };
  }
  async function replay() {
    const rows = await handle.sql<{ plan_id: string; request: unknown }[]>`
      select plan_id, request from mcp.write_previews where org_id = ${c.orgId} and key_id = ${c.keyId}
        and request_id = ${r.requestId}`;
    if (rows.length === 0) return null;
    if (rows.length !== 1 || serializeMcpBidPreviewRequest(McpBidPreviewRequest.parse(rows[0]!.request))
      !== serializeMcpBidPreviewRequest(r)) throw new SpWriteApplicationError('identity_conflict');
    const recorded = await loadSpWritePreviewEvidence(handle.sql, { orgId: c.orgId, profileId: r.profileId, planId: rows[0]!.plan_id });
    if (!recorded || recorded.evidence.schemaVersion !== 'openspell.sp-write-preview-evidence.v2'
      || recorded.evidence.guardrails.delegation.keyId !== c.keyId) throw new SpWriteApplicationError('identity_conflict');
    return { preview: SpWritePreview.parse({ ...recorded, binding: spWritePlanBinding(recorded.plan) }),
      delegation: recorded.evidence.guardrails.delegation };
  }
  try {
    const authority = await context();
    const prior = await replay();
    if (prior) return prior;
    const artifact = McpBidProposalArtifact.parse({ schemaVersion: 'openspell.mcp-bid-proposal.v1',
      orgId: c.orgId, profileId: r.profileId, applyBatchId: randomUUID(), requestId: r.requestId,
      keyId: c.keyId, issuerUserId: authority.delegation.issuerUserId, delegationVersionId: authority.delegation.versionId,
      preparedAt: authority.now, note: proposals.note,
      rows: proposals.rows.map((row) => ({ ...row, applyRowId: randomUUID() })) });
    const artifactText = serializeMcpBidProposalArtifact(artifact); const planId = randomUUID();
    const evidence = SpMcpWritePreviewEvidenceV2.parse({ schemaVersion: 'openspell.sp-write-preview-evidence.v2', planId,
      guardrails: { profileGrantId: authority.profileGrantId, profileGrantVersion: authority.profileGrantVersion,
        providerScope: authority.providerScope, maximumProviderRows: 500, requireCurrentValueMatch: true, delegation: authority.delegation },
      provenance: { kind: 'mcp_keyword_proposals', applyBatchId: artifact.applyBatchId, artifactText,
        artifactSha256: digest(artifactText), preparedAt: artifact.preparedAt, rows: artifact.rows } });
    const actions = artifact.rows.map((row) => {
      const action = SpWriteAction.parse({ actionId: randomUUID(), routeKey: 'sp.v3.keywords.update', entity: { keywordId: row.keywordId },
        sources: [{ kind: 'apply_row', applyRowId: row.applyRowId, changeKey: 'keyword.bid' }],
        changes: { bid: { expected: { amount: row.expectedBid, currencyCode: authority.providerScope.currencyCode },
          requested: { amount: row.requestedBid, currencyCode: authority.providerScope.currencyCode } } }, fingerprint: ZERO });
      return { ...action, fingerprint: digest(serializeSpWriteActionFingerprint(action)) };
    });
    const plan = SpWritePlan.parse({ schemaVersion: 'openspell.sp-write-plan.v2', id: planId, orgId: c.orgId,
      profileId: r.profileId, providerScope: authority.providerScope, direction: 'forward',
      source: { kind: 'apply_batch', applyBatchId: artifact.applyBatchId,
        guardrailSnapshotFingerprint: digest(serializeSpWritePreviewGuardrails(evidence)),
        provenanceSnapshotFingerprint: digest(serializeSpWritePreviewProvenance(evidence)) },
      generatedAt: authority.now, frozenAt: authority.now,
      expiresAt: new Date(Math.min(Date.parse(authority.now) + 15 * 60_000, Date.parse(authority.delegation.expiresAt))).toISOString(),
      actions, counts: { logicalChanges: actions.length, providerRows: actions.length, uniqueEntities: actions.length,
        byRoute: { 'sp.v3.campaigns.update': 0, 'sp.v3.ad_groups.update': 0, 'sp.v3.keywords.update': actions.length,
          'sp.v3.targets.update': 0, 'sp.v3.product_ads.update': 0 } }, fingerprint: ZERO });
    plan.fingerprint = digest(serializeSpWritePlanFingerprint(plan));
    try { verifyMcpWritePreviewEvidenceArtifacts(plan, evidence, hasher); }
    catch { throw new SpWriteApplicationError('authorization_refused'); }
    try {
      const rows = await handle.sql<{ plan_id: string }[]>`select app.prepare_mcp_bid_proposals_v1(
        ${c.orgId},${c.keyId},${c.tokenHash},${JSON.stringify(r)},${serializeMcpBidPreviewRequest(r)},
        ${artifactText},${JSON.stringify(plan)},${serializeSpWritePlanFingerprint(plan)},
        ${JSON.stringify(plan.actions.map((action) => ({ artifactText: JSON.stringify(action),
          fingerprintPreimage: serializeSpWriteActionFingerprint(action) })))}::jsonb,
        ${JSON.stringify(evidence)},${serializeSpWritePreviewGuardrails(evidence)},${serializeSpWritePreviewProvenance(evidence)}
      )::text as plan_id`;
      if (rows.length !== 1 || !rows[0]?.plan_id) throw new SpWriteApplicationError('outcome_unknown');
    } catch (error) {
      // A lost response may hide a committed preview. Reauthenticate before recovery.
      await context();
      const committed = await replay();
      if (committed) return committed;
      throw error;
    }
    const saved = await replay();
    if (!saved) throw new SpWriteApplicationError('outcome_unknown');
    return saved;
  } catch (error) { return refuse(error); }
}
