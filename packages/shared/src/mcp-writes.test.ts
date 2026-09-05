import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ApproveSpWritePlan, McpBidApplyRequest, McpWriteDelegation, SpHumanAuthorizationReceiptV1,
  SpWriteAction, SpWriteAuthorizationReceipt, SpWritePlan, SpDelegatedAuthorizationReceiptV2,
  serializeMcpWriteDelegationFingerprint, serializeSpWriteActionFingerprint,
  serializeSpWritePlanFingerprint, spWriteAuthorizationActor, spWritePlanBinding,
  verifyDelegatedSpWriteReceiptArtifacts, verifyMcpPlanLimits, verifyMcpWriteDelegationFingerprint,
  verifySpWriteAuthorizationReceiptArtifacts, verifySpWriteExecutionEvidence, verifySpWriteJobArtifacts,
} from './sp-writes.js';
import {
  McpBidPreviewRequest, McpWriteStatus, McpWriteStatusRequest, McpKeyTokenDigest,
  McpWriteKeyIssueRequest, McpWriteKeyIssued, McpWriteKeySummary,
} from './mcp-writes.js';
import { SpWriteManualApprovalRequest } from './sp-write-application.js';
import { TimeMachineNativeWrite } from './time-machine-writes.js';

const id = (suffix: string) => `00000000-0000-4000-8000-${suffix.padStart(12, '0')}`;
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const hasher = { algorithm: 'sha256' as const, digest: hash };
const at = '2026-09-06T00:00:00.000Z';
const later = '2026-09-06T00:15:00.000Z';
const scope = { amazonProfileId: 'synthetic-profile', connectionId: id('7'), region: 'NA',
  marketplaceId: 'synthetic-market', currencyCode: 'USD', apiDialect: 'sp_v3' };

function plan(oldBid = '0.3', newBid = '0.33', inverse = false) {
  const action = SpWriteAction.parse({ actionId: id('12'), routeKey: 'sp.v3.keywords.update',
    entity: { keywordId: 'synthetic-keyword' },
    sources: inverse ? [{ kind: 'inverse_action', sourceActionId: id('13'), changeKey: 'keyword.bid' }]
      : [{ kind: 'apply_row', applyRowId: id('13'), changeKey: 'keyword.bid' }],
    changes: { bid: { expected: { amount: oldBid, currencyCode: 'USD' },
      requested: { amount: newBid, currencyCode: 'USD' } } }, fingerprint: '0'.repeat(64) });
  const p = SpWritePlan.parse({ schemaVersion: 'openspell.sp-write-plan.v1', id: id('1'), orgId: id('2'),
    profileId: id('3'), providerScope: scope, direction: inverse ? 'inverse' : 'forward',
    source: inverse ? { kind: 'inverse_execution', sourceExecutionId: id('17'), sourcePlanId: id('16'), sourcePlanFingerprint: 'b'.repeat(64) }
      : { kind: 'apply_batch', applyBatchId: id('11'), guardrailSnapshotFingerprint: 'a'.repeat(64), provenanceSnapshotFingerprint: 'b'.repeat(64) },
    generatedAt: at, frozenAt: at, expiresAt: later,
    actions: [{ ...action, fingerprint: hash(serializeSpWriteActionFingerprint(action)) }],
    counts: { logicalChanges: 1, providerRows: 1, uniqueEntities: 1, byRoute: {
      'sp.v3.campaigns.update': 0, 'sp.v3.ad_groups.update': 0, 'sp.v3.keywords.update': 1,
      'sp.v3.targets.update': 0, 'sp.v3.product_ads.update': 0 } }, fingerprint: '0'.repeat(64) });
  return { ...p, fingerprint: hash(serializeSpWritePlanFingerprint(p)) };
}

function delegation(ratio = '0.1', absolute = '0.03') {
  const d = McpWriteDelegation.parse({ schemaVersion: 'openspell.mcp-write-delegation.v1', versionId: id('4'),
    keyId: id('5'), keyLabel: 'Synthetic integration', orgId: id('2'), issuerUserId: id('6'),
    profiles: [{ profileId: id('3'), currencyCode: 'USD' }], issuedAt: at, expiresAt: '2026-09-07T00:00:00.000Z',
    limits: { action: 'keyword.bid', maximumRowsPerCall: 2, maximumRowsPerUtcDay: 3,
      maximumAbsoluteDeltaByCurrency: [{ amount: absolute, currencyCode: 'USD' }], maximumRelativeDelta: ratio },
    fingerprint: '0'.repeat(64) });
  return { ...d, fingerprint: hash(serializeMcpWriteDelegationFingerprint(d)) };
}

function artifacts(p = plan(), d = delegation()) {
  const request = McpBidApplyRequest.parse({ requestId: id('8'), profileId: p.profileId,
    planId: p.id, planFingerprint: p.fingerprint });
  const receipt = SpDelegatedAuthorizationReceiptV2.parse({ schemaVersion: 'openspell.sp-write-authorization-receipt.v2',
    approvalId: id('9'), approvalRequestId: request.requestId, executionId: id('17'), generation: id('10'),
    approvalMode: 'delegated_mcp', plan: spWritePlanBinding(p), preapprovedInversePlan: null, boundedAuthorization: null,
    approvedBy: d.issuerUserId, approvedAt: at, expiresAt: later,
    confirmationVersion: 'openspell.mcp-delegated-bid-admission.v1',
    gateSnapshot: { environmentGate: 'enabled', environmentGateVersion: id('20'), profileGrantId: id('21'),
      profileGrantVersion: id('22'), gateSnapshotFingerprint: 'c'.repeat(64), checkedAt: at },
    mcpGate: { versionId: id('23'), enabled: true, checkedAt: at }, delegation: d,
    reservation: { id: id('24'), day: '2026-09-06', rows: 1, releasedRows: 0 } });
  return { p, d, request, receipt };
}

function execution() {
  const { receipt } = artifacts();
  return { operation: { executionId: receipt.executionId, planId: receipt.plan.planId }, admission: 'queued', receipt,
    snapshot: { status: 'queued', accounting: { approvedRows: 1, pendingDispatch: 1, refusedBeforeDispatch: 0,
      intentCommitted: 0, providerAccepted: 0, providerRejected: 0, providerAmbiguous: 0, observedRequested: 0,
      observedExpectedAfterAmbiguous: 0, observationConflict: 0, observationMissing: 0, pendingObservation: 0,
      providerCallsCommitted: 0, providerCallsCompleted: 0 } },
    mirror: { observations: 0, pending: 0, promoted: 0, alreadyCurrent: 0, superseded: 0, missing: 0 },
    original: null, inverses: [] };
}

describe('bounded MCP write contracts', () => {
  it('keeps token material out of operator policy and persisted key summaries', () => {
    const d = delegation();
    const request = { label: d.keyLabel, profileIds: d.profiles.map((profile) => profile.profileId),
      expiresAt: d.expiresAt, limits: d.limits };
    const token = ['wza', 'a'.repeat(43)].join('_');
    const digest = { tokenHash: hash(token), keyPrefix: token.slice(0, 12) };
    expect(McpWriteKeyIssueRequest.parse(request)).toEqual(request);
    expect(McpWriteKeyIssueRequest.safeParse({ ...request, ...digest }).success).toBe(false);
    expect(McpKeyTokenDigest.parse(digest)).toEqual(digest);
    expect(McpKeyTokenDigest.safeParse({ ...digest, token }).success).toBe(false);
    expect(McpWriteKeyIssued.parse({ delegation: d, token })).toEqual({ delegation: d, token });
    const summary = { delegation: d, revokedAt: at, lastUsedAt: null };
    expect(McpWriteKeySummary.parse(summary)).toEqual(summary);
    expect(McpWriteKeySummary.safeParse({ ...summary, token }).success).toBe(false);
  });
  it('preserves legacy human receipt bytes and refuses delegated authority through human approval', () => {
    const { p, d, request, receipt } = artifacts();
    const { delegation: _delegation, reservation: _reservation, mcpGate: _mcpGate, ...common } = receipt;
    const legacy = { ...common, schemaVersion: 'openspell.sp-write-authorization-receipt.v1', approvalMode: 'manual',
      confirmationVersion: 'openspell.amazon-sp-write-confirmation.v1' };
    expect(JSON.stringify(SpWriteAuthorizationReceipt.parse(legacy))).toBe(JSON.stringify(SpHumanAuthorizationReceiptV1.parse(legacy)));
    const human = { approvalRequestId: request.requestId, plan: receipt.plan, approvalMode: 'manual',
      confirmationVersion: 'openspell.amazon-sp-write-confirmation.v1', boundedAuthorization: null, preapprovedInversePlan: null };
    expect(verifySpWriteAuthorizationReceiptArtifacts(p, null, human, null, legacy, at, hasher).receipt.approvalMode).toBe('manual');
    expect(() => verifySpWriteAuthorizationReceiptArtifacts(p, null, human, null, receipt, at, hasher)).toThrow();
    expect(ApproveSpWritePlan.safeParse({ ...human, approvalMode: 'delegated_mcp' }).success).toBe(false);
    expect(SpWriteManualApprovalRequest.safeParse({ profileId: p.profileId, approval: request }).success).toBe(false);
    expect(verifyDelegatedSpWriteReceiptArtifacts(p, d, request, receipt, at, hasher).receipt).toEqual(receipt);
  });

  it('requires immutable fingerprinted scope and refuses enlarged or substituted delegation artifacts', () => {
    const { p, d, request, receipt } = artifacts();
    for (const changed of [
      { ...d, keyId: id('99') }, { ...d, issuerUserId: id('98') },
      { ...d, profiles: [{ profileId: id('97'), currencyCode: 'USD' }] },
      { ...d, limits: { ...d.limits, maximumRowsPerUtcDay: 5 } },
    ]) expect(() => verifyMcpWriteDelegationFingerprint(changed, hasher)).toThrow();
    expect(() => verifyDelegatedSpWriteReceiptArtifacts(p, d, { ...request, planFingerprint: 'd'.repeat(64) }, receipt, at, hasher)).toThrow();
    expect(McpBidApplyRequest.safeParse({ ...request, issuerUserId: d.issuerUserId }).success).toBe(false);
    expect(McpWriteDelegation.safeParse({ ...d, profiles: [...d.profiles, ...d.profiles] }).success).toBe(false);
    expect(McpWriteDelegation.safeParse({ ...d, expiresAt: '2026-12-05T00:00:00.001Z' }).success).toBe(false);
    expect(McpWriteDelegation.safeParse({ ...d, limits: { ...d.limits, maximumAbsoluteDeltaByCurrency: [] } }).success).toBe(false);
  });

  it('compares decimal ratio and currency deltas exactly at inclusive boundaries', () => {
    expect(() => verifyMcpPlanLimits(plan(), delegation())).not.toThrow();
    expect(() => verifyMcpPlanLimits(plan('0.3', '0.3301'), delegation('0.1', '1'))).toThrow();
    expect(() => verifyMcpPlanLimits(plan('0.3', '0.3301'), delegation('1', '0.03'))).toThrow();
    expect(() => verifyMcpPlanLimits(plan('0.3333', '0.3666'), delegation('0.1', '1'))).not.toThrow();
    expect(() => verifyMcpPlanLimits(plan('0.3333', '0.3667'), delegation('0.1', '1'))).toThrow();
    expect(() => verifyMcpPlanLimits(plan('0.3', '0.30001'), delegation())).toThrow();
    expect(() => verifyMcpPlanLimits({ ...plan(), orgId: id('99') }, delegation())).toThrow();
  });

  it('checks the inverse against its own current value and fresh limits', () => {
    const d = delegation('0.5', '1');
    expect(() => verifyMcpPlanLimits(plan('0.8', '0.4'), d)).not.toThrow();
    expect(() => verifyMcpPlanLimits(plan('0.4', '0.8', true), d)).toThrow();
    const { p, request, receipt } = artifacts(plan('0.4', '0.8', true), delegation('1', '1'));
    expect(verifyDelegatedSpWriteReceiptArtifacts(p, receipt.delegation, request, receipt, at, hasher).receipt.plan.direction).toBe('inverse');
    expect(() => verifyDelegatedSpWriteReceiptArtifacts(p, receipt.delegation, request,
      { ...receipt, executionId: id('999') }, at, hasher)).toThrow();
  });

  it('binds receipt issuer, UTC charge, row count, gates and authority expiry', () => {
    const { p, d, request, receipt } = artifacts();
    for (const mutation of [
      { approvedBy: id('99') }, { reservation: { ...receipt.reservation, day: '2026-09-05' } },
      { reservation: { ...receipt.reservation, rows: 2 } }, { reservation: { ...receipt.reservation, releasedRows: 1 } },
      { mcpGate: { ...receipt.mcpGate, enabled: false } }, { expiresAt: '2026-09-08T00:00:00.000Z' },
      { preapprovedInversePlan: receipt.plan },
    ]) expect(SpWriteAuthorizationReceipt.safeParse({ ...receipt, ...mutation }).success).toBe(false);
    expect(() => verifyDelegatedSpWriteReceiptArtifacts(p, d, request, receipt, later, hasher)).toThrow();
  });

  it('rehydrates delegated history without live key access and rejects corrupted authority in worker jobs', () => {
    const { p, receipt } = artifacts();
    const e = execution();
    const evidence = { plan: p, authorization: receipt, snapshot: e.snapshot, predispatchObservations: [],
      predispatchDispositions: [], providerCallIntents: [], providerResults: [], observations: [] };
    expect(verifySpWriteExecutionEvidence(evidence, hasher).authorization).toEqual(receipt);
    const corrupted = { ...receipt, delegation: { ...receipt.delegation,
      limits: { ...receipt.delegation.limits, maximumRowsPerUtcDay: 4 } } };
    expect(() => verifySpWriteExecutionEvidence({ ...evidence, authorization: corrupted }, hasher)).toThrow();
    const job = { type: 'sp_write.dispatch', orgId: p.orgId, profileId: p.profileId, planId: p.id,
      planFingerprint: p.fingerprint, executionId: receipt.executionId, approvalId: receipt.approvalId, generation: receipt.generation };
    expect(verifySpWriteJobArtifacts(p, receipt, job, at, hasher).authorization).toEqual(receipt);
    expect(() => verifySpWriteJobArtifacts(p, corrupted, job, at, hasher)).toThrow();
  });

  it('requires real, unique, exact bid proposals and supports lost-response request lookup', () => {
    const request = { requestId: id('1'), profileId: id('3'), source: { kind: 'keyword_proposals', note: 'Synthetic proposal',
      rows: [{ keywordId: 'synthetic-keyword', expectedBid: '0.3', requestedBid: '0.33' }] } };
    expect(McpBidPreviewRequest.safeParse(request).success).toBe(true);
    for (const amount of ['0', '0.3300', '3.3e-1', '0.33001', '100000000']) {
      expect(McpBidPreviewRequest.safeParse({ ...request, source: { ...request.source,
        rows: [{ ...request.source.rows[0], requestedBid: amount }] } }).success).toBe(false);
    }
    expect(McpBidPreviewRequest.safeParse({ ...request, source: { ...request.source,
      rows: [...request.source.rows, ...request.source.rows] } }).success).toBe(false);
    expect(McpBidPreviewRequest.safeParse({ ...request, ownerUserId: id('6') }).success).toBe(false);
    expect(McpWriteStatusRequest.safeParse({ profileId: id('3'), lookup: { kind: 'apply_request', requestId: id('8') } }).success).toBe(true);
    expect(McpWriteStatus.parse({ kind: 'request_unresolved', requestId: id('8') }).kind).toBe('request_unresolved');
  });

  it('derives key/issuer history from the receipt and rejects a forged human or other-key actor', () => {
    const e = execution();
    const actor = spWriteAuthorizationActor(e.receipt);
    const entry = { execution: e, actor, actionId: id('12'), direction: 'forward',
      change: { key: 'keyword.bid', expected: { amount: '0.3', currencyCode: 'USD' }, requested: { amount: '0.33', currencyCode: 'USD' } },
      provenance: { kind: 'apply_row', applyRowId: id('13'), changeKey: 'keyword.bid' },
      phase: 'queued', refusal: null, observation: null, mirrorReceipt: null, inverseSummaries: [] };
    expect(TimeMachineNativeWrite.parse(entry).actor).toEqual({ kind: 'mcp_key', userId: id('6'), keyId: id('5'), delegationVersionId: id('4') });
    expect(TimeMachineNativeWrite.safeParse({ ...entry, actor: { kind: 'operator', userId: id('6') } }).success).toBe(false);
    expect(TimeMachineNativeWrite.safeParse({ ...entry, actor: { ...actor, keyId: id('99') } }).success).toBe(false);
    const status = { kind: 'found', execution: e, capacity: { requested: 1, reserved: 1, attempted: 0, accepted: 0, observed: 0, refused: 0, released: 0 } };
    expect(McpWriteStatus.safeParse(status).success).toBe(true);
    expect(McpWriteStatus.safeParse({ ...status, capacity: { ...status.capacity, accepted: 1 } }).success).toBe(false);
  });
});
