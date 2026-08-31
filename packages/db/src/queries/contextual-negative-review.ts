/**
 * Complete-scope human review and immutable offline exports for contextual
 * negatives. This module owns the encoding, locking, stale-state, audit, and
 * exact-count rules; callers supply only authenticated scope and actor data.
 */
import { createHash } from 'node:crypto';
import {
  ContextualNegativeProposal,
  type ContextualNegativeProposal as ContextualNegativeProposalType,
} from '@wizard-ads/shared';
import type { DbHandle, QuerySql } from '../client.js';

export const CONTEXTUAL_NEGATIVE_ACTION_LIMIT = 500;
export const CONTEXTUAL_NEGATIVE_REVIEW_ROW_LIMIT = 5_000;
export const CONTEXTUAL_NEGATIVE_REVIEW_BYTE_LIMIT = 8 * 1024 * 1024;
export const CONTEXTUAL_NEGATIVE_REVIEW_TIMEOUT_MS = 5_000;
export const CONTEXTUAL_NEGATIVE_EXPORT_HISTORY_LIMIT = 100;

const FINGERPRINT_DOMAIN = 'wizard-ads.contextual-negative-review-fingerprint.v1\n';
const LOCK_DOMAIN = 'wizard-ads.contextual-negative-review-scope.v1\n';
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const MAX_ACTOR_BYTES = 1_024;
const MAX_NOTE_BYTES = 16 * 1024;
const REVIEW_FINGERPRINT_BYTES = 64;

export type ContextualNegativeQueryHandle = Pick<DbHandle, 'sql'>;
export type ContextualNegativeDecision = 'accepted' | 'dismissed' | 'proposed';
export type ContextualNegativeExportFormat = 'json' | 'csv';

export interface ContextualNegativeProposalExpectation {
  id: string;
  expectedFingerprint: string;
}

export interface ContextualNegativeFingerprintInput {
  orgId: string;
  id: string;
  profileId: string;
  marketplaceId: string;
  campaignId: string;
  adGroupId: string;
  searchTerm: string;
  normalizedQuery: string;
  category: ContextualNegativeProposalType['category'];
  sourceGroupRole: ContextualNegativeProposalType['sourceGroupRole'];
  matchType: ContextualNegativeProposalType['matchType'];
  reason: string;
  status: ContextualNegativeProposalType['status'];
}

export type ContextualNegativeProposalRecord = Omit<ContextualNegativeProposalType, 'id'> & {
  id: string;
  decisionNote: string | null;
  decidedBy: string | null;
  decidedAt: Date | null;
  reviewFingerprint: string;
};

export interface ContextualNegativeStatusCounts {
  total: number;
  proposed: number;
  accepted: number;
  dismissed: number;
  exported: number;
}

interface ContextualNegativeReviewMeasurements {
  rowCount: number;
  reviewBytes: number;
  statusCounts: ContextualNegativeStatusCounts;
}

export interface ContextualNegativeReviewReady extends ContextualNegativeReviewMeasurements {
  status: 'ready';
  proposals: ContextualNegativeProposalRecord[];
}

export interface ContextualNegativeReviewCapacityExceeded
  extends ContextualNegativeReviewMeasurements {
  status: 'capacity_exceeded';
  reason: 'row_limit' | 'byte_limit' | 'timeout';
  measurementsAvailable: boolean;
  limits: {
    rows: number;
    reviewBytes: number;
    timeoutMs: number;
  };
  proposals: [];
}

export type ContextualNegativeReviewLoad =
  | ContextualNegativeReviewReady
  | ContextualNegativeReviewCapacityExceeded;

export interface ContextualNegativeExportSummary {
  id: string;
  profileId: string;
  marketplaceId: string;
  note: string;
  rowCount: number;
  jsonSha256: string;
  csvSha256: string;
  createdBy: string;
  createdAt: Date;
  amazonUpdated: false;
}

export interface ContextualNegativeDecisionResult {
  offered: number;
  matched: number;
  updated: number;
  unchanged: number;
  changed: Array<{
    id: string;
    status: ContextualNegativeDecision;
    decisionNote: string | null;
    decidedBy: string;
    decidedAt: Date;
    reviewFingerprint: string;
  }>;
  amazonUpdated: false;
}

export interface ContextualNegativeExportResult {
  exportId: string;
  offered: number;
  matched: number;
  accepted: number;
  stamped: number;
  storedJsonRows: number;
  rowCount: number;
  jsonSha256: string;
  csvSha256: string;
  exportedIds: string[];
  createdAt: Date;
  amazonUpdated: false;
}

export interface ContextualNegativeStoredArtifact {
  exportId: string;
  format: ContextualNegativeExportFormat;
  bytes: Buffer;
  sha256: string;
  rowCount: number;
  createdAt: Date;
  amazonUpdated: false;
}

export class ContextualNegativeReviewError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContextualNegativeReviewError';
  }
}

export class ContextualNegativeReviewValidationError extends ContextualNegativeReviewError {
  constructor(message: string) {
    super(message);
    this.name = 'ContextualNegativeReviewValidationError';
  }
}

export class ContextualNegativeReviewConflictError extends ContextualNegativeReviewError {
  constructor(readonly proposalIds: readonly string[]) {
    super('Proposal review changed since this page loaded. Reload and try again.');
    this.name = 'ContextualNegativeReviewConflictError';
  }
}

export class ContextualNegativeReviewStateError extends ContextualNegativeReviewError {
  constructor(readonly proposalIds: readonly string[], message: string) {
    super(message);
    this.name = 'ContextualNegativeReviewStateError';
  }
}

export class ContextualNegativeReviewLockTimeoutError extends ContextualNegativeReviewError {
  constructor() {
    super('Contextual-negative review scope is busy. Reload and retry the command.');
    this.name = 'ContextualNegativeReviewLockTimeoutError';
  }
}

export class ContextualNegativeReviewCapacityError extends ContextualNegativeReviewError {
  constructor(readonly capacity: ContextualNegativeReviewCapacityExceeded) {
    super(`Contextual-negative review capacity exceeded: ${capacity.reason}`);
    this.name = 'ContextualNegativeReviewCapacityError';
  }
}

export class ContextualNegativeArtifactIntegrityError extends ContextualNegativeReviewError {
  constructor(message: string) {
    super(message);
    this.name = 'ContextualNegativeArtifactIntegrityError';
  }
}

type DateValue = Date | string;

interface ProposalRow {
  org_id: string;
  id: string;
  profile_id: string;
  marketplace_id: string;
  campaign_id: string;
  ad_group_id: string;
  search_term: string;
  normalized_query: string;
  category: ContextualNegativeProposalType['category'];
  source_group_role: ContextualNegativeProposalType['sourceGroupRole'];
  match_type: ContextualNegativeProposalType['matchType'];
  reason: string;
  status: ContextualNegativeProposalType['status'];
  created_at: DateValue;
  updated_at: DateValue;
  decision_note: string | null;
  decided_by: string | null;
  decided_at: DateValue | null;
}

interface StatsRow {
  row_count: number;
  review_bytes: string | number;
  proposed_count: number;
  accepted_count: number;
  dismissed_count: number;
  exported_count: number;
}

interface ExportRow {
  id: string;
  org_id: string;
  profile_id: string;
  marketplace_id: string;
  note: string;
  row_count: number;
  json_artifact: Buffer;
  json_sha256: string;
  csv_artifact: Buffer;
  csv_sha256: string;
  created_by: string;
  created_at: DateValue;
}

export interface ContextualNegativeExportProposalSnapshot extends ContextualNegativeFingerprintInput {
  reviewFingerprint: string;
}

export interface ContextualNegativeExportEnvelope {
  version: 1;
  exportId: string;
  orgId: string;
  profileId: string;
  marketplaceId: string;
  note: string;
  createdAt: string;
  rowCount: number;
  amazonUpdated: false;
  proposals: ContextualNegativeExportProposalSnapshot[];
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function toDate(value: DateValue): Date {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new ContextualNegativeReviewError(`Invalid database timestamp: ${String(value)}`);
  }
  return date;
}

function sha256(bytes: string | Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function json(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new ContextualNegativeReviewError('Value is not JSON serializable');
  }
  return serialized;
}

function compareAscii(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function validateUuid(value: string, label: string): string {
  const normalized = value.toLowerCase();
  if (!UUID_PATTERN.test(normalized) || normalized !== value) {
    throw new ContextualNegativeReviewValidationError(`${label} must be a lowercase UUID`);
  }
  return normalized;
}

function boundedText(value: string, label: string, maxBytes: number, required: boolean): string {
  const trimmed = value.trim();
  if (required && trimmed.length === 0) {
    throw new ContextualNegativeReviewValidationError(`${label} must not be empty`);
  }
  if (utf8Bytes(trimmed) > maxBytes) {
    throw new ContextualNegativeReviewValidationError(`${label} exceeds ${maxBytes} UTF-8 bytes`);
  }
  return trimmed;
}

function validateScope(input: { orgId: string; profileId: string; marketplaceId: string }): void {
  validateUuid(input.orgId, 'orgId');
  validateUuid(input.profileId, 'profileId');
  boundedText(input.marketplaceId, 'marketplaceId', 1_024, true);
}

function fingerprintInput(row: ProposalRow): ContextualNegativeFingerprintInput {
  return {
    orgId: row.org_id,
    id: row.id,
    profileId: row.profile_id,
    marketplaceId: row.marketplace_id,
    campaignId: row.campaign_id,
    adGroupId: row.ad_group_id,
    searchTerm: row.search_term,
    normalizedQuery: row.normalized_query,
    category: row.category,
    sourceGroupRole: row.source_group_role,
    matchType: row.match_type,
    reason: row.reason,
    status: row.status,
  };
}

/** Frozen version-1 semantic fingerprint; incidental timestamps are excluded. */
export function contextualNegativeReviewFingerprint(
  input: ContextualNegativeFingerprintInput,
): string {
  const payload = [
    input.orgId,
    input.id,
    input.profileId,
    input.marketplaceId,
    input.campaignId,
    input.adGroupId,
    input.searchTerm,
    input.normalizedQuery,
    input.category,
    input.sourceGroupRole,
    input.matchType,
    input.reason,
    input.status,
  ];
  return sha256(`${FINGERPRINT_DOMAIN}${json(payload)}\n`);
}

function proposalReviewBytes(row: ProposalRow): number {
  const textBytes = [
    row.org_id,
    row.id,
    row.profile_id,
    row.marketplace_id,
    row.campaign_id,
    row.ad_group_id,
    row.search_term,
    row.normalized_query,
    row.category,
    row.source_group_role,
    row.match_type,
    row.reason,
    row.status,
    row.decision_note ?? '',
    row.decided_by ?? '',
  ].reduce((total, value) => total + utf8Bytes(value), 0);
  const decidedAt = row.decided_at === null ? '' : toDate(row.decided_at).toISOString();
  return textBytes + utf8Bytes(decidedAt) + REVIEW_FINGERPRINT_BYTES;
}

function proposalFromRow(row: ProposalRow): ContextualNegativeProposalRecord {
  const parsed = ContextualNegativeProposal.parse({
    id: row.id,
    profileId: row.profile_id,
    marketplaceId: row.marketplace_id,
    campaignId: row.campaign_id,
    adGroupId: row.ad_group_id,
    searchTerm: row.search_term,
    normalizedQuery: row.normalized_query,
    category: row.category,
    sourceGroupRole: row.source_group_role,
    matchType: row.match_type,
    reason: row.reason,
    status: row.status,
  });
  if (parsed.id === undefined) {
    throw new ContextualNegativeReviewError('Contextual-negative proposal read-back has no id');
  }
  return {
    ...parsed,
    id: parsed.id,
    decisionNote: row.decision_note,
    decidedBy: row.decided_by,
    decidedAt: row.decided_at === null ? null : toDate(row.decided_at),
    reviewFingerprint: contextualNegativeReviewFingerprint(fingerprintInput(row)),
  };
}

function measurementsFromStats(row: StatsRow | undefined): ContextualNegativeReviewMeasurements {
  if (row === undefined) {
    return {
      rowCount: 0,
      reviewBytes: 0,
      statusCounts: { total: 0, proposed: 0, accepted: 0, dismissed: 0, exported: 0 },
    };
  }
  const rowCount = Number(row.row_count);
  return {
    rowCount,
    reviewBytes: Number(row.review_bytes),
    statusCounts: {
      total: rowCount,
      proposed: Number(row.proposed_count),
      accepted: Number(row.accepted_count),
      dismissed: Number(row.dismissed_count),
      exported: Number(row.exported_count),
    },
  };
}

function capacity(
  reason: ContextualNegativeReviewCapacityExceeded['reason'],
  measurements: ContextualNegativeReviewMeasurements,
  measurementsAvailable = true,
): ContextualNegativeReviewCapacityExceeded {
  return {
    status: 'capacity_exceeded',
    reason,
    measurementsAvailable,
    ...measurements,
    limits: {
      rows: CONTEXTUAL_NEGATIVE_REVIEW_ROW_LIMIT,
      reviewBytes: CONTEXTUAL_NEGATIVE_REVIEW_BYTE_LIMIT,
      timeoutMs: CONTEXTUAL_NEGATIVE_REVIEW_TIMEOUT_MS,
    },
    proposals: [],
  };
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}

/**
 * Load one complete review scope from one repeatable-read snapshot. Oversized
 * scopes return measurements but never a truncated proposal list.
 */
export async function loadContextualNegativeReview(
  handle: ContextualNegativeQueryHandle,
  input: { orgId: string; profileId: string; marketplaceId: string },
): Promise<ContextualNegativeReviewLoad> {
  validateScope(input);
  let observed = measurementsFromStats(undefined);
  let measurementsAvailable = false;
  try {
    return await handle.sql.begin('isolation level repeatable read read only', async (sql) => {
      await sql`set local statement_timeout = '5s'`;
      const stats = await sql<StatsRow[]>`
        select count(*)::int as row_count,
               coalesce(sum(
                 octet_length(p.org_id::text) + octet_length(p.id::text)
                 + octet_length(p.profile_id::text) + octet_length(p.marketplace_id)
                 + octet_length(p.campaign_id) + octet_length(p.ad_group_id)
                 + octet_length(p.search_term) + octet_length(p.normalized_query)
                 + octet_length(p.category::text) + octet_length(p.source_group_role)
                 + octet_length(p.match_type) + octet_length(p.reason)
                 + octet_length(p.status)
                 + ${REVIEW_FINGERPRINT_BYTES}
                 + coalesce(octet_length(decision.payload ->> 'note'), 0)
                 + coalesce(octet_length(decision.actor_id), 0)
                 + coalesce(octet_length(
                     to_char(
                       decision.created_at at time zone 'UTC',
                       'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
                     )
                   ), 0)
               ), 0)::bigint as review_bytes,
               count(*) filter (where p.status = 'proposed')::int as proposed_count,
               count(*) filter (where p.status = 'accepted')::int as accepted_count,
               count(*) filter (where p.status = 'dismissed')::int as dismissed_count,
               count(*) filter (where p.status = 'exported')::int as exported_count
          from public.contextual_negative_proposals p
          left join lateral (
            select a.payload, a.actor_id, a.created_at
              from public.audit_log a
             where a.org_id = p.org_id
               and a.target_type = 'contextual_negative_proposal'
               and a.target_id = p.id::text
               and a.action in (
                 'query_negative.accepted',
                 'query_negative.dismissed',
                 'query_negative.reopened'
               )
             order by a.created_at desc, a.id desc
             limit 1
          ) decision on true
         where p.org_id = ${input.orgId}
           and p.profile_id = ${input.profileId}
           and p.marketplace_id = ${input.marketplaceId}
      `;
      observed = measurementsFromStats(stats[0]);
      measurementsAvailable = true;
      if (observed.rowCount > CONTEXTUAL_NEGATIVE_REVIEW_ROW_LIMIT) {
        return capacity('row_limit', observed);
      }
      if (observed.reviewBytes > CONTEXTUAL_NEGATIVE_REVIEW_BYTE_LIMIT) {
        return capacity('byte_limit', observed);
      }

      const rows = await sql<ProposalRow[]>`
        select p.org_id, p.id, p.profile_id, p.marketplace_id, p.campaign_id,
               p.ad_group_id, p.search_term, p.normalized_query, p.category,
               p.source_group_role, p.match_type, p.reason, p.status,
               p.created_at, p.updated_at,
               decision.payload ->> 'note' as decision_note,
               decision.actor_id as decided_by,
               decision.created_at as decided_at
          from public.contextual_negative_proposals p
          left join lateral (
            select a.payload, a.actor_id, a.created_at
              from public.audit_log a
             where a.org_id = p.org_id
               and a.target_type = 'contextual_negative_proposal'
               and a.target_id = p.id::text
               and a.action in (
                 'query_negative.accepted',
                 'query_negative.dismissed',
                 'query_negative.reopened'
               )
             order by a.created_at desc, a.id desc
             limit 1
          ) decision on true
         where p.org_id = ${input.orgId}
           and p.profile_id = ${input.profileId}
           and p.marketplace_id = ${input.marketplaceId}
         order by case p.status
                    when 'proposed' then 0
                    when 'accepted' then 1
                    when 'dismissed' then 2
                    else 3
                  end,
                  p.created_at, p.id::text collate "C"
      `;
      const fetchedMeasurements: ContextualNegativeReviewMeasurements = {
        rowCount: rows.length,
        reviewBytes: rows.reduce((total, row) => total + proposalReviewBytes(row), 0),
        statusCounts: {
          total: rows.length,
          proposed: rows.filter((row) => row.status === 'proposed').length,
          accepted: rows.filter((row) => row.status === 'accepted').length,
          dismissed: rows.filter((row) => row.status === 'dismissed').length,
          exported: rows.filter((row) => row.status === 'exported').length,
        },
      };
      if (json(fetchedMeasurements) !== json(observed)) {
        throw new ContextualNegativeReviewError(
          'Contextual-negative review count or byte assertion failed inside its snapshot',
        );
      }
      const proposals = rows.map(proposalFromRow);
      if (proposals.length !== observed.rowCount) {
        throw new ContextualNegativeReviewError('Contextual-negative proposal parse count mismatch');
      }
      return { status: 'ready', ...observed, proposals };
    });
  } catch (error) {
    if (errorCode(error) === '57014') {
      return capacity('timeout', observed, measurementsAvailable);
    }
    throw error;
  }
}

/** Compatibility helper for callers that deliberately treat capacity as an error. */
export async function listContextualNegativeProposals(
  handle: ContextualNegativeQueryHandle,
  input: { orgId: string; profileId: string; marketplaceId: string },
): Promise<ContextualNegativeProposalRecord[]> {
  const result = await loadContextualNegativeReview(handle, input);
  if (result.status === 'capacity_exceeded') {
    throw new ContextualNegativeReviewCapacityError(result);
  }
  return result.proposals;
}

function exportSummaryFromRow(row: ExportRow): ContextualNegativeExportSummary {
  return {
    id: row.id,
    profileId: row.profile_id,
    marketplaceId: row.marketplace_id,
    note: row.note,
    rowCount: Number(row.row_count),
    jsonSha256: row.json_sha256,
    csvSha256: row.csv_sha256,
    createdBy: row.created_by,
    createdAt: toDate(row.created_at),
    amazonUpdated: false,
  };
}

export async function listContextualNegativeExports(
  handle: ContextualNegativeQueryHandle,
  input: { orgId: string; profileId: string; marketplaceId: string },
): Promise<ContextualNegativeExportSummary[]> {
  validateScope(input);
  const rows = await handle.sql<ExportRow[]>`
    select id, org_id, profile_id, marketplace_id, note, row_count,
           ''::bytea as json_artifact, json_sha256,
           ''::bytea as csv_artifact, csv_sha256, created_by, created_at
      from public.contextual_negative_exports
     where org_id = ${input.orgId}
       and profile_id = ${input.profileId}
       and marketplace_id = ${input.marketplaceId}
     order by created_at desc, id::text collate "C" desc
     limit ${CONTEXTUAL_NEGATIVE_EXPORT_HISTORY_LIMIT}
  `;
  return rows.map(exportSummaryFromRow);
}

function normalizeExpectations(
  proposals: readonly ContextualNegativeProposalExpectation[],
): ContextualNegativeProposalExpectation[] {
  if (proposals.length === 0) {
    throw new ContextualNegativeReviewValidationError('Select at least one proposal');
  }
  if (proposals.length > CONTEXTUAL_NEGATIVE_ACTION_LIMIT) {
    throw new ContextualNegativeReviewValidationError(
      `A contextual-negative command is limited to ${CONTEXTUAL_NEGATIVE_ACTION_LIMIT} proposals`,
    );
  }
  const seen = new Set<string>();
  const normalized = proposals.map((proposal, index) => {
    const id = validateUuid(proposal.id, `proposals[${index}].id`);
    if (seen.has(id)) {
      throw new ContextualNegativeReviewValidationError(`Proposal ${id} was supplied more than once`);
    }
    seen.add(id);
    if (!SHA256_PATTERN.test(proposal.expectedFingerprint)) {
      throw new ContextualNegativeReviewValidationError(
        `Proposal ${id} has an invalid review fingerprint`,
      );
    }
    return { id, expectedFingerprint: proposal.expectedFingerprint };
  });
  return normalized.sort((left, right) => compareAscii(left.id, right.id));
}

function assertExpectedRows(
  rows: readonly ProposalRow[],
  expectations: readonly ContextualNegativeProposalExpectation[],
): void {
  const byId = new Map(rows.map((row) => [row.id, row] as const));
  const conflicts = expectations
    .filter((expected) => {
      const row = byId.get(expected.id);
      return row === undefined
        || contextualNegativeReviewFingerprint(fingerprintInput(row)) !== expected.expectedFingerprint;
    })
    .map((expected) => expected.id);
  if (conflicts.length > 0 || rows.length !== expectations.length) {
    throw new ContextualNegativeReviewConflictError(conflicts);
  }
}

function scopeLockKey(scope: { orgId: string; profileId: string; marketplaceId: string }): string {
  return `${LOCK_DOMAIN}${scope.orgId}\n${scope.profileId}\n${scope.marketplaceId}`;
}

export function contextualNegativeReviewScopeLockKeys(
  scopes: readonly { orgId: string; profileId: string; marketplaceId: string }[],
): string[] {
  const unique = new Set<string>();
  for (const scope of scopes) {
    validateScope(scope);
    unique.add(scopeLockKey(scope));
  }
  return [...unique].sort(compareAscii);
}

/**
 * Acquire contextual-negative scope locks in bytewise marketplace order.
 * Refresh, decision, reopen, and export all call this exact helper.
 */
export async function lockContextualNegativeReviewScopes(
  sql: QuerySql,
  scopes: readonly { orgId: string; profileId: string; marketplaceId: string }[],
): Promise<void> {
  for (const key of contextualNegativeReviewScopeLockKeys(scopes)) {
    await sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
  }
}

async function withReviewTransaction<T>(
  handle: ContextualNegativeQueryHandle,
  operation: (sql: QuerySql) => Promise<T>,
): Promise<T> {
  try {
    const wrapped = await handle.sql.begin(async (sql) => {
      await sql`set local lock_timeout = '5s'`;
      await sql`set local statement_timeout = '5s'`;
      return { value: await operation(sql) };
    });
    return wrapped.value;
  } catch (error) {
    if (errorCode(error) === '55P03' || errorCode(error) === '57014') {
      throw new ContextualNegativeReviewLockTimeoutError();
    }
    throw error;
  }
}

async function assertSelectedRowsWithinCapacity(
  sql: QuerySql,
  input: { orgId: string; profileId: string; marketplaceId: string },
  expectations: readonly ContextualNegativeProposalExpectation[],
): Promise<void> {
  const ids = expectations.map((proposal) => proposal.id);
  const [measurement] = await sql<{ row_count: number; review_bytes: string | number }[]>`
    select count(*)::int as row_count,
           coalesce(sum(
             octet_length(p.org_id::text) + octet_length(p.id::text)
             + octet_length(p.profile_id::text) + octet_length(p.marketplace_id)
             + octet_length(p.campaign_id) + octet_length(p.ad_group_id)
             + octet_length(p.search_term) + octet_length(p.normalized_query)
             + octet_length(p.category::text) + octet_length(p.source_group_role)
             + octet_length(p.match_type) + octet_length(p.reason)
             + octet_length(p.status)
             + ${REVIEW_FINGERPRINT_BYTES}
           ), 0)::bigint as review_bytes
      from public.contextual_negative_proposals p
     where p.org_id = ${input.orgId}
       and p.profile_id = ${input.profileId}
       and p.marketplace_id = ${input.marketplaceId}
       and p.id = any (${ids}::uuid[])
  `;
  if (Number(measurement?.row_count ?? 0) !== expectations.length) {
    throw new ContextualNegativeReviewConflictError(ids);
  }
  if (Number(measurement?.review_bytes ?? 0) > CONTEXTUAL_NEGATIVE_REVIEW_BYTE_LIMIT) {
    throw new ContextualNegativeReviewValidationError(
      `Selected contextual-negative review fields exceed ${CONTEXTUAL_NEGATIVE_REVIEW_BYTE_LIMIT} UTF-8 bytes`,
    );
  }
}

async function lockSelectedRows(
  sql: QuerySql,
  input: { orgId: string; profileId: string; marketplaceId: string },
  expectations: readonly ContextualNegativeProposalExpectation[],
): Promise<ProposalRow[]> {
  const ids = expectations.map((proposal) => proposal.id);
  const rows = await sql<ProposalRow[]>`
    select p.org_id, p.id, p.profile_id, p.marketplace_id, p.campaign_id,
           p.ad_group_id, p.search_term, p.normalized_query, p.category,
           p.source_group_role, p.match_type, p.reason, p.status,
           p.created_at, p.updated_at,
           null::text as decision_note, null::text as decided_by,
           null::timestamptz as decided_at
      from public.contextual_negative_proposals p
     where p.org_id = ${input.orgId}
       and p.profile_id = ${input.profileId}
       and p.marketplace_id = ${input.marketplaceId}
       and p.id = any (${ids}::uuid[])
     order by p.id::text collate "C"
     for update
  `;
  assertExpectedRows(rows, expectations);
  return rows;
}

function auditBefore(row: ProposalRow): ContextualNegativeExportProposalSnapshot {
  const before = fingerprintInput(row);
  return {
    ...before,
    reviewFingerprint: contextualNegativeReviewFingerprint(before),
  };
}

export async function decideContextualNegativeProposals(
  handle: ContextualNegativeQueryHandle,
  input: {
    orgId: string;
    profileId: string;
    marketplaceId: string;
    proposals: readonly ContextualNegativeProposalExpectation[];
    decision: ContextualNegativeDecision;
    actorId: string;
    note?: string | null;
  },
): Promise<ContextualNegativeDecisionResult> {
  validateScope(input);
  const proposals = normalizeExpectations(input.proposals);
  const actorId = boundedText(input.actorId, 'actorId', MAX_ACTOR_BYTES, true);
  const note = boundedText(input.note ?? '', 'note', MAX_NOTE_BYTES, input.decision === 'dismissed');
  if (!(['accepted', 'dismissed', 'proposed'] as const).includes(input.decision)) {
    throw new ContextualNegativeReviewValidationError('Unknown contextual-negative decision');
  }

  return withReviewTransaction(handle, async (sql) => {
    await lockContextualNegativeReviewScopes(sql, [input]);
    await assertSelectedRowsWithinCapacity(sql, input, proposals);
    const rows = await lockSelectedRows(sql, input, proposals);
    const terminal = rows.filter((row) => row.status === 'exported').map((row) => row.id);
    if (terminal.length > 0) {
      throw new ContextualNegativeReviewStateError(
        terminal,
        'Exported contextual-negative proposals are terminal',
      );
    }
    const changed = rows.filter((row) => row.status !== input.decision);
    const unchanged = rows.length - changed.length;
    if (changed.length === 0) {
      return {
        offered: proposals.length,
        matched: rows.length,
        updated: 0,
        unchanged,
        changed: [],
        amazonUpdated: false,
      };
    }

    const action = input.decision === 'proposed'
      ? 'query_negative.reopened'
      : `query_negative.${input.decision}`;
    const payloads = changed.map((row) => json({
      before: auditBefore(row),
      targetStatus: input.decision,
      note,
    }));
    const audits = await sql<{ id: number }[]>`
      insert into public.audit_log
        (org_id, actor_type, actor_id, action, target_type, target_id,
         payload, source)
      select ${input.orgId}, 'user', ${actorId}, ${action},
             'contextual_negative_proposal', event.proposal_id,
             event.payload::jsonb, 'web'
        from unnest(
          ${changed.map((row) => row.id)}::text[],
          ${payloads}::text[]
        ) as event(proposal_id, payload)
      returning id
    `;
    if (audits.length !== changed.length) {
      throw new ContextualNegativeReviewError(
        `Contextual-negative decision expected ${changed.length} audits, wrote ${audits.length}`,
      );
    }

    const changedIds = changed.map((row) => row.id);
    const updated = await sql<{ id: string; status: ContextualNegativeDecision; updated_at: DateValue }[]>`
      update public.contextual_negative_proposals
         set status = ${input.decision}, updated_at = transaction_timestamp()
       where org_id = ${input.orgId}
         and profile_id = ${input.profileId}
         and marketplace_id = ${input.marketplaceId}
         and id = any (${changedIds}::uuid[])
         and status <> 'exported'
      returning id, status, updated_at
    `;
    if (updated.length !== changed.length) {
      throw new ContextualNegativeReviewError(
        `Contextual-negative decision expected ${changed.length} updates, wrote ${updated.length}`,
      );
    }
    const beforeById = new Map(changed.map((row) => [row.id, row] as const));
    const changedResult = updated
      .map((row) => {
        const before = beforeById.get(row.id);
        if (before === undefined) {
          throw new ContextualNegativeReviewError(`Updated unselected proposal ${row.id}`);
        }
        const after: ProposalRow = { ...before, status: row.status, updated_at: row.updated_at };
        return {
          id: row.id,
          status: row.status,
          decisionNote: note || null,
          decidedBy: actorId,
          decidedAt: toDate(row.updated_at),
          reviewFingerprint: contextualNegativeReviewFingerprint(fingerprintInput(after)),
        };
      })
      .sort((left, right) => compareAscii(left.id, right.id));
    if (proposals.length !== rows.length || rows.length !== updated.length + unchanged
        || updated.length !== audits.length) {
      throw new ContextualNegativeReviewError('Contextual-negative decision counts do not reconcile');
    }
    return {
      offered: proposals.length,
      matched: rows.length,
      updated: updated.length,
      unchanged,
      changed: changedResult,
      amazonUpdated: false,
    };
  });
}

function exportSnapshot(row: ProposalRow): ContextualNegativeExportProposalSnapshot {
  return auditBefore(row);
}

/** Fixed version-1 JSON encoding: two-space indentation, UTF-8, and one LF. */
export function serializeContextualNegativeExportJson(envelope: ContextualNegativeExportEnvelope): Buffer {
  return Buffer.from(`${JSON.stringify(envelope, null, 2)}\n`, 'utf8');
}

const CSV_COLUMNS = [
  'org_id',
  'id',
  'profile_id',
  'marketplace_id',
  'campaign_id',
  'ad_group_id',
  'search_term',
  'normalized_query',
  'category',
  'source_group_role',
  'match_type',
  'reason',
  'status',
  'review_fingerprint',
  'amazon_updated',
] as const;

function csvCell(input: string): string {
  const literal = /^[\s\p{Cc}\p{Cf}]*[=+\-@]/u.test(input) ? `'${input}` : input;
  return /[",\r\n]/u.test(literal) ? `"${literal.replaceAll('"', '""')}"` : literal;
}

/** Fixed version-1 CSV encoding with formula-prefix hardening and LF records. */
export function serializeContextualNegativeExportCsv(
  proposals: readonly ContextualNegativeExportProposalSnapshot[],
): Buffer {
  const records = [CSV_COLUMNS.join(',')];
  for (const proposal of proposals) {
    records.push([
      proposal.orgId,
      proposal.id,
      proposal.profileId,
      proposal.marketplaceId,
      proposal.campaignId,
      proposal.adGroupId,
      proposal.searchTerm,
      proposal.normalizedQuery,
      proposal.category,
      proposal.sourceGroupRole,
      proposal.matchType,
      proposal.reason,
      proposal.status,
      proposal.reviewFingerprint,
      'false',
    ].map(csvCell).join(','));
  }
  return Buffer.from(`${records.join('\n')}\n`, 'utf8');
}

/** Count strict RFC-style CSV records while allowing quoted CR/LF cells. */
export function countContextualNegativeCsvRecords(bytes: Buffer): number {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new ContextualNegativeArtifactIntegrityError('Contextual-negative CSV is not valid UTF-8');
  }
  if (text.startsWith('\uFEFF') || !text.endsWith('\n')) {
    throw new ContextualNegativeArtifactIntegrityError(
      'Contextual-negative CSV must have no BOM and exactly terminated records',
    );
  }
  let records = 0;
  let inQuotes = false;
  let fieldStart = true;
  let afterQuote = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (inQuotes) {
      if (character === '"') {
        if (text[index + 1] === '"') index += 1;
        else {
          inQuotes = false;
          afterQuote = true;
        }
      }
      continue;
    }
    if (afterQuote) {
      if (character === ',') {
        afterQuote = false;
        fieldStart = true;
        continue;
      }
      if (character === '\n') {
        records += 1;
        afterQuote = false;
        fieldStart = true;
        continue;
      }
      throw new ContextualNegativeArtifactIntegrityError('Malformed contextual-negative CSV quote');
    }
    if (character === '"') {
      if (!fieldStart) {
        throw new ContextualNegativeArtifactIntegrityError('Malformed contextual-negative CSV quote');
      }
      inQuotes = true;
      fieldStart = false;
    } else if (character === ',') {
      fieldStart = true;
    } else if (character === '\n') {
      records += 1;
      fieldStart = true;
    } else if (character === '\r') {
      throw new ContextualNegativeArtifactIntegrityError('Unquoted CR in contextual-negative CSV');
    } else {
      fieldStart = false;
    }
  }
  if (inQuotes || afterQuote) {
    throw new ContextualNegativeArtifactIntegrityError('Unterminated contextual-negative CSV quote');
  }
  return records;
}

function parseAndVerifyJson(row: ExportRow): ContextualNegativeExportEnvelope {
  if (sha256(row.json_artifact) !== row.json_sha256) {
    throw new ContextualNegativeArtifactIntegrityError('Contextual-negative JSON hash mismatch');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(row.json_artifact));
  } catch {
    throw new ContextualNegativeArtifactIntegrityError('Contextual-negative JSON is invalid');
  }
  if (typeof parsed !== 'object' || parsed === null || !('proposals' in parsed)
      || !Array.isArray(parsed.proposals) || !('rowCount' in parsed)
      || parsed.rowCount !== row.row_count || parsed.proposals.length !== row.row_count
      || !('exportId' in parsed) || parsed.exportId !== row.id
      || !('amazonUpdated' in parsed) || parsed.amazonUpdated !== false) {
    throw new ContextualNegativeArtifactIntegrityError('Contextual-negative JSON row count or identity mismatch');
  }
  return parsed as ContextualNegativeExportEnvelope;
}

function verifyExportRow(row: ExportRow): ContextualNegativeExportEnvelope {
  const envelope = parseAndVerifyJson(row);
  if (sha256(row.csv_artifact) !== row.csv_sha256) {
    throw new ContextualNegativeArtifactIntegrityError('Contextual-negative CSV hash mismatch');
  }
  const records = countContextualNegativeCsvRecords(row.csv_artifact);
  if (records !== row.row_count + 1) {
    throw new ContextualNegativeArtifactIntegrityError(
      `Contextual-negative CSV expected ${row.row_count + 1} records, found ${records}`,
    );
  }
  return envelope;
}

export async function exportAcceptedContextualNegatives(
  handle: ContextualNegativeQueryHandle,
  input: {
    orgId: string;
    profileId: string;
    marketplaceId: string;
    proposals: readonly ContextualNegativeProposalExpectation[];
    actorId: string;
    note: string;
  },
): Promise<ContextualNegativeExportResult> {
  validateScope(input);
  const proposals = normalizeExpectations(input.proposals);
  const actorId = boundedText(input.actorId, 'actorId', MAX_ACTOR_BYTES, true);
  const note = boundedText(input.note, 'note', MAX_NOTE_BYTES, true);

  return withReviewTransaction(handle, async (sql) => {
    await lockContextualNegativeReviewScopes(sql, [input]);
    await assertSelectedRowsWithinCapacity(sql, input, proposals);
    const rows = await lockSelectedRows(sql, input, proposals);
    const nonAccepted = rows.filter((row) => row.status !== 'accepted').map((row) => row.id);
    if (nonAccepted.length > 0) {
      throw new ContextualNegativeReviewStateError(
        nonAccepted,
        'Every selected contextual-negative proposal must still be accepted',
      );
    }

    const ordered = [...rows].sort((left, right) => compareAscii(left.id, right.id));
    const snapshots = ordered.map(exportSnapshot);
    const [identity] = await sql<{ id: string; created_at: DateValue }[]>`
      select gen_random_uuid() as id, clock_timestamp() as created_at
    `;
    if (identity === undefined) {
      throw new ContextualNegativeReviewError('Database did not allocate an export identity');
    }
    const createdAt = toDate(identity.created_at);
    const envelope: ContextualNegativeExportEnvelope = {
      version: 1,
      exportId: identity.id,
      orgId: input.orgId,
      profileId: input.profileId,
      marketplaceId: input.marketplaceId,
      note,
      createdAt: createdAt.toISOString(),
      rowCount: snapshots.length,
      amazonUpdated: false,
      proposals: snapshots,
    };
    const jsonArtifact = serializeContextualNegativeExportJson(envelope);
    const csvArtifact = serializeContextualNegativeExportCsv(snapshots);
    const jsonSha256 = sha256(jsonArtifact);
    const csvSha256 = sha256(csvArtifact);
    if (countContextualNegativeCsvRecords(csvArtifact) !== snapshots.length + 1) {
      throw new ContextualNegativeArtifactIntegrityError('Created CSV record count does not reconcile');
    }
    if (parseAndVerifyJson({
      id: identity.id,
      org_id: input.orgId,
      profile_id: input.profileId,
      marketplace_id: input.marketplaceId,
      note,
      row_count: snapshots.length,
      json_artifact: jsonArtifact,
      json_sha256: jsonSha256,
      csv_artifact: csvArtifact,
      csv_sha256: csvSha256,
      created_by: actorId,
      created_at: createdAt,
    }).proposals.length !== snapshots.length) {
      throw new ContextualNegativeArtifactIntegrityError('Created JSON row count does not reconcile');
    }

    const inserted = await sql<ExportRow[]>`
      insert into public.contextual_negative_exports
        (id, org_id, profile_id, marketplace_id, note, row_count,
         json_artifact, json_sha256, csv_artifact, csv_sha256,
         created_by, created_at)
      values (
        ${identity.id}, ${input.orgId}, ${input.profileId}, ${input.marketplaceId},
        ${note}, ${snapshots.length}, ${jsonArtifact}, ${jsonSha256},
        ${csvArtifact}, ${csvSha256}, ${actorId}, ${createdAt.toISOString()}::timestamptz
      )
      returning *
    `;
    if (inserted.length !== 1 || inserted[0] === undefined) {
      throw new ContextualNegativeReviewError('Contextual-negative export did not store exactly one row');
    }

    const auditPayload = json({
      exportId: identity.id,
      scope: {
        orgId: input.orgId,
        profileId: input.profileId,
        marketplaceId: input.marketplaceId,
      },
      proposalIds: snapshots.map((proposal) => proposal.id),
      proposalFingerprints: snapshots.map((proposal) => proposal.reviewFingerprint),
      rowCount: snapshots.length,
      jsonSha256,
      csvSha256,
      note,
      amazonUpdated: false,
    });
    const audits = await sql<{ id: number }[]>`
      insert into public.audit_log
        (org_id, actor_type, actor_id, action, target_type, target_id,
         payload, source)
      values (
        ${input.orgId}, 'user', ${actorId}, 'query_negative.exported',
        'contextual_negative_export', ${identity.id}, ${auditPayload}::text::jsonb, 'web'
      )
      returning id
    `;
    if (audits.length !== 1) {
      throw new ContextualNegativeReviewError('Contextual-negative export audit was not written exactly once');
    }

    const stamped = await sql<{ id: string }[]>`
      update public.contextual_negative_proposals
         set status = 'exported', updated_at = transaction_timestamp()
       where org_id = ${input.orgId}
         and profile_id = ${input.profileId}
         and marketplace_id = ${input.marketplaceId}
         and id = any (${snapshots.map((proposal) => proposal.id)}::uuid[])
         and status = 'accepted'
      returning id
    `;
    if (stamped.length !== snapshots.length) {
      throw new ContextualNegativeReviewError(
        `Contextual-negative export expected ${snapshots.length} stamps, wrote ${stamped.length}`,
      );
    }

    const readBack = await sql<ExportRow[]>`
      select * from public.contextual_negative_exports
       where org_id = ${input.orgId} and id = ${identity.id}
    `;
    const stored = readBack[0];
    if (readBack.length !== 1 || stored === undefined) {
      throw new ContextualNegativeReviewError('Contextual-negative export read-back count mismatch');
    }
    const storedEnvelope = verifyExportRow(stored);
    const counts = {
      offered: proposals.length,
      matched: rows.length,
      accepted: rows.filter((row) => row.status === 'accepted').length,
      stamped: stamped.length,
      storedJsonRows: storedEnvelope.proposals.length,
      rowCount: Number(stored.row_count),
    };
    if (new Set(Object.values(counts)).size !== 1) {
      throw new ContextualNegativeReviewError('Contextual-negative export counts do not reconcile');
    }
    return {
      exportId: identity.id,
      ...counts,
      jsonSha256,
      csvSha256,
      exportedIds: stamped.map((row) => row.id).sort(compareAscii),
      createdAt,
      amazonUpdated: false,
    };
  });
}

/** Retrieve and verify exact stored bytes. No artifact is rerendered. */
export async function getContextualNegativeExport(
  handle: ContextualNegativeQueryHandle,
  input: { orgId: string; exportId: string; format: ContextualNegativeExportFormat },
): Promise<ContextualNegativeStoredArtifact | null> {
  validateUuid(input.orgId, 'orgId');
  validateUuid(input.exportId, 'exportId');
  if (input.format !== 'json' && input.format !== 'csv') {
    throw new ContextualNegativeReviewValidationError('Unknown contextual-negative export format');
  }
  const rows = await handle.sql<ExportRow[]>`
    select * from public.contextual_negative_exports
     where org_id = ${input.orgId} and id = ${input.exportId}
  `;
  const row = rows[0];
  if (row === undefined) return null;
  verifyExportRow(row);
  return {
    exportId: row.id,
    format: input.format,
    bytes: input.format === 'json' ? row.json_artifact : row.csv_artifact,
    sha256: input.format === 'json' ? row.json_sha256 : row.csv_sha256,
    rowCount: Number(row.row_count),
    createdAt: toDate(row.created_at),
    amazonUpdated: false,
  };
}
