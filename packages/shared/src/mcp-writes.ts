import { z } from 'zod';
import { AmazonId, Uuid } from './primitives.js';
import { SpWriteOperationDetail, SpWriteOperationId, SpWritePreview } from './sp-write-application.js';
import {
  McpBidLimits, McpWriteDelegation, McpWriteReservation, SpKeywordBidDecimal, SpWriteSha256, verifyMcpPlanLimits,
} from './sp-writes.js';

export { McpBidApplyRequest, McpBidLimits, McpWriteDelegation, McpWriteReservation } from './sp-writes.js';

const id = Uuid.refine((value) => value === value.toLowerCase(), 'use canonical lowercase UUIDs');
const proposal = z.object({ keywordId: AmazonId, expectedBid: SpKeywordBidDecimal,
  requestedBid: SpKeywordBidDecimal }).strict().refine((value) => value.expectedBid !== value.requestedBid,
  'a proposal must change the bid');

/** The server resolves every proposed entity and actor before storing real source rows. */
export const McpBidPreviewRequest = z.object({
  requestId: id,
  profileId: id,
  source: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('apply_batch'), applyBatchId: id }).strict(),
    z.object({ kind: z.literal('keyword_proposals'), note: z.string().trim().min(1).max(1_000),
      rows: z.array(proposal).min(1).max(500).refine((rows) =>
        new Set(rows.map((row) => row.keywordId)).size === rows.length, 'duplicate keyword proposals') }).strict(),
    z.object({ kind: z.literal('inverse'), original: SpWriteOperationId }).strict(),
  ]),
}).strict();
export type McpBidPreviewRequest = z.infer<typeof McpBidPreviewRequest>;

export const McpWriteStatusRequest = z.object({
  profileId: id,
  lookup: z.discriminatedUnion('kind', [
    SpWriteOperationId.extend({ kind: z.literal('operation') }).strict(),
    z.object({ kind: z.literal('apply_request'), requestId: id }).strict(),
  ]),
}).strict();
export type McpWriteStatusRequest = z.infer<typeof McpWriteStatusRequest>;

/** Displayed capacity is a snapshot, not permission to apply the preview. */
export const McpBidPreview = z.object({
  preview: SpWritePreview,
  delegation: McpWriteDelegation,
  dailyRows: z.object({ day: z.iso.date(), reserved: z.number().int().nonnegative().max(2_147_483_647),
    maximum: z.number().int().min(1).max(2_147_483_647) }).strict(),
}).strict().superRefine((value, context) => {
  const plan = value.preview.plan;
  try { verifyMcpPlanLimits(plan, value.delegation); }
  catch { context.addIssue({ code: 'custom', message: 'preview exceeds delegated plan limits' }); }
  if (value.dailyRows.maximum !== value.delegation.limits.maximumRowsPerUtcDay
    || value.dailyRows.reserved > value.dailyRows.maximum
    || value.delegation.orgId !== plan.orgId
    || !value.delegation.profiles.some((profile) => profile.profileId === plan.profileId
      && profile.currencyCode === plan.providerScope.currencyCode)) {
    context.addIssue({ code: 'custom', message: 'preview differs from its delegation or budget snapshot' });
  }
});
export type McpBidPreview = z.infer<typeof McpBidPreview>;

export const McpBidAdmission = z.object({
  kind: z.literal('queued'),
  operation: SpWriteOperationId,
  approvalId: id,
  approvalRequestId: id,
  reservation: McpWriteReservation,
}).strict();
export type McpBidAdmission = z.infer<typeof McpBidAdmission>;

export const McpWriteCapacityCounts = z.object({
  requested: z.number().int().min(1).max(500),
  reserved: z.number().int().min(1).max(500),
  attempted: z.number().int().nonnegative().max(500),
  accepted: z.number().int().nonnegative().max(500),
  observed: z.number().int().nonnegative().max(500),
  refused: z.number().int().nonnegative().max(500),
  released: z.literal(0),
}).strict().refine((value) => value.requested === value.reserved && value.accepted <= value.attempted
  && value.observed <= value.attempted && value.attempted + value.refused <= value.reserved,
  'capacity counts must reconcile; observed may exceed accepted after an ambiguous response');
export type McpWriteCapacityCounts = z.infer<typeof McpWriteCapacityCounts>;

export const McpWriteStatus = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('found'), execution: SpWriteOperationDetail,
    capacity: McpWriteCapacityCounts }).strict().superRefine((value, context) => {
    const receipt = value.execution.receipt;
    const a = value.execution.snapshot.accounting;
    const c = value.capacity;
    if (receipt.approvalMode !== 'delegated_mcp' || value.execution.admission !== 'queued'
      || c.requested !== a.approvedRows || c.reserved !== a.approvedRows
      || (receipt.approvalMode === 'delegated_mcp' && c.reserved !== receipt.reservation.rows)
      || c.attempted !== a.intentCommitted || c.accepted !== a.providerAccepted
      || c.observed !== a.observedRequested || c.refused !== a.refusedBeforeDispatch) {
      context.addIssue({ code: 'custom', message: 'MCP capacity counts differ from the execution ledger' });
    }
  }),
  /** A concurrent admission may still be in flight; absence never proves no change. */
  z.object({ kind: z.literal('request_unresolved'), requestId: id }).strict(),
]);
export type McpWriteStatus = z.infer<typeof McpWriteStatus>;

/** Exact actor-free policy requested at the separate operator issuance endpoint. */
export const McpWriteKeyIssueRequest = z.object({
  label: z.string().trim().min(1).max(160),
  profileIds: z.array(id).min(1).refine((ids) => new Set(ids).size === ids.length, 'duplicate profile IDs'),
  expiresAt: z.iso.datetime(),
  limits: McpBidLimits,
}).strict();
export type McpWriteKeyIssueRequest = z.infer<typeof McpWriteKeyIssueRequest>;

export const McpApiKeyScope = z.enum(['read', 'write']);
export type McpApiKeyScope = z.infer<typeof McpApiKeyScope>;

/** Server-minted token material passed to persistence; the plaintext never enters this contract. */
export const McpKeyTokenDigest = z.object({
  tokenHash: SpWriteSha256,
  keyPrefix: z.string().regex(/^wza_[A-Za-z0-9_-]{8}$/),
}).strict();
export type McpKeyTokenDigest = z.infer<typeof McpKeyTokenDigest>;

/** One-time operator response. Never persist this object or include it in an audit event. */
export const McpWriteKeyIssued = z.object({
  delegation: McpWriteDelegation,
  token: z.string().regex(/^wza_[A-Za-z0-9_-]{43}$/),
}).strict();
export type McpWriteKeyIssued = z.infer<typeof McpWriteKeyIssued>;

/** Management/history may still display expired or revoked authority. */
export const McpWriteKeySummary = z.object({
  delegation: McpWriteDelegation,
  revokedAt: z.iso.datetime().nullable(),
  lastUsedAt: z.iso.datetime().nullable(),
}).strict();
export type McpWriteKeySummary = z.infer<typeof McpWriteKeySummary>;
