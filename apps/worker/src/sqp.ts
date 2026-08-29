/**
 * Weekly SP-API Search Query Performance workflow.
 *
 * A queue job can span several slow provider polls. Its checkpoint therefore
 * lives on the owning `sync_jobs` ledger row: retries and process restarts reuse
 * report ids instead of creating duplicate Amazon reports. The analytical
 * promotion remains transactional and independently idempotent in packages/db.
 */
import { createHash } from 'node:crypto';
import {
  listQueryVocabulary,
  persistContextualNegativeProposals,
  promoteSqpWeeklyFacts,
  readWeeklyPpcQueryFacts,
  type ContextualProposalPersistenceCounts,
  type DbHandle,
  type SqpWeeklyPromotionInput,
  type SqpWeeklyPromotionResult,
  type SqpSourceReportMetadata,
  type VocabularyPersistenceCounts,
  type WeeklyPpcQueryRecord,
} from '@wizard-ads/db';
import {
  classifyQuery,
  joinSqpAndPpc,
  proposeContextualNegative,
  rollupQueryCategories,
  verifySpendConservation,
  type ContextualNegativePolicy,
  type PpcQueryFact,
} from '@wizard-ads/core';
import {
  SqpRequestJob,
  type ContextualNegativeProposal,
  type QueryCategory,
  type QueryVocabularyEntry,
  type SqpIngestionCounts,
  type SqpRequestJob as SqpRequestJobType,
  type SqpWeeklyFact,
} from '@wizard-ads/shared';
import {
  parseSqpReport,
  planSqpReportRequests,
  SQP_REPORT_TYPE,
  type CreateReportInput,
  type ParsedSqpReport,
  type SpApiReport,
  type SpApiReportDocument,
  type SqpReportRequestPlan,
} from '@wizard-ads/sp-api';

export type SqpProviderOperation =
  | 'create_report'
  | 'get_report'
  | 'get_report_document'
  | 'download_report_document';

export interface SqpProviderGate {
  beforeCall(operation: SqpProviderOperation, requestKey: string): Promise<void>;
}

export interface SqpReportApi {
  createReport(input: CreateReportInput): Promise<{ reportId: string }>;
  getReport(reportId: string): Promise<SpApiReport>;
  getReportDocument(reportDocumentId: string): Promise<SpApiReportDocument>;
  downloadReportDocument(document: SpApiReportDocument): Promise<unknown>;
}

type SqpBatchStatus = 'planned' | 'requested' | 'ready' | 'empty';

export interface SqpBatchCheckpoint {
  requestKey: string;
  plan: SqpReportRequestPlan;
  status: SqpBatchStatus;
  reportId: string | null;
  reportDocumentId: string | null;
  createdByWorkflow: boolean;
  /** Worker request time used for promotion freshness ordering. */
  requestedAt: string | null;
  /** Provider metadata; it is not substituted for worker freshness time. */
  providerCreatedAt: string | null;
  /** Worker observation time for a terminal provider state. */
  completedAt: string | null;
}

export interface SqpWorkflowCheckpoint {
  runKey: string;
  orgId: string;
  profileId: string;
  marketplaceId: string;
  weekStart: string;
  weekEnd: string;
  batches: SqpBatchCheckpoint[];
  completed: CompletedSqpWorkflowResult | null;
}

export interface SqpWorkflowCheckpointStore {
  load(runKey: string): Promise<SqpWorkflowCheckpoint | null>;
  save(checkpoint: SqpWorkflowCheckpoint): Promise<void>;
}

export interface SqpQueuedJobContext {
  jobId: string;
}

export interface SqpRoutingContext {
  ppc: WeeklyPpcQueryRecord;
  category: QueryCategory;
}

export interface SqpRoutingDecision {
  sourceGroupRole: NonNullable<WeeklyPpcQueryRecord['groupRole']>;
  policy: ContextualNegativePolicy;
}

export interface SqpWorkflowDataStore {
  listVocabulary(input: { orgId: string; marketplaceId: string }): Promise<QueryVocabularyEntry[]>;
  promoteFacts(input: SqpWeeklyPromotionInput): Promise<SqpWeeklyPromotionResult>;
  listPpcFacts(input: {
    orgId: string;
    profileId: string;
    marketplaceId: string;
    weekStart: string;
    weekEnd: string;
  }): Promise<WeeklyPpcQueryRecord[]>;
  persistProposals(input: {
    orgId: string;
    profileId: string;
    proposals: readonly ContextualNegativeProposal[];
  }): Promise<ContextualProposalPersistenceCounts>;
}

export interface SqpWorkflowDependencies {
  api: SqpReportApi;
  providerGate: SqpProviderGate;
  checkpoints: SqpWorkflowCheckpointStore;
  data: SqpWorkflowDataStore;
  /** Absent until tenant routing policy explicitly supports a proposal. */
  resolveRouting?: (context: SqpRoutingContext) => SqpRoutingDecision | null;
  /**
   * Amazon uses CANCELLED both for automatic no-data and manual cancellation.
   * Only independent provider evidence may confirm that deletion is safe.
   */
  confirmCancelledNoData?: (context: {
    batch: SqpBatchCheckpoint;
    report: SpApiReport;
  }) => Promise<boolean>;
  nextPollAfterSeconds?: number;
  now?: () => Date;
}

export interface PendingSqpWorkflowResult {
  status: 'pending';
  runKey: string;
  reports: {
    total: number;
    planned: number;
    requested: number;
    ready: number;
    empty: number;
  };
  nextPollAfterSeconds: number;
}

export interface CompletedSqpWorkflowResult {
  status: 'completed';
  runKey: string;
  reused: boolean;
  reports: {
    total: number;
    created: number;
    reusedCompleted: number;
    empty: number;
  };
  ingestion: SqpWeeklyPromotionResult;
  categories: ReturnType<typeof rollupQueryCategories>;
  joins: {
    asinExact: number;
    profileOnly: number;
    ambiguous: number;
    unmatched: number;
    inputRows: number;
    outputRows: number;
    inputSpend: number;
    outputSpend: number;
  };
  proposals: ContextualProposalPersistenceCounts;
}

export type SqpWorkflowResult = PendingSqpWorkflowResult | CompletedSqpWorkflowResult;

export class SqpWorkflowPermanentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SqpWorkflowPermanentError';
  }
}

/** Yield an unfinished provider report back to the durable queue. */
export class SqpWorkflowPendingError extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super(`SQP reports are still processing; retry after ${retryAfterSeconds} seconds`);
    this.name = 'SqpWorkflowPendingError';
  }
}

/** Execute at most one provider-status poll per report, then yield pending. */
export async function runSqpRequestWorkflow(
  payloadValue: SqpRequestJobType,
  dependencies: SqpWorkflowDependencies,
): Promise<SqpWorkflowResult> {
  const payload = SqpRequestJob.parse(payloadValue);
  const plans = planSqpReportRequests(payload);
  const runKey = workflowKey(payload, plans);
  let checkpoint = await dependencies.checkpoints.load(runKey);
  if (checkpoint === null) checkpoint = freshCheckpoint(runKey, payload, plans);
  validateCheckpoint(checkpoint, payload, plans);
  if (checkpoint.completed !== null) {
    return { ...checkpoint.completed, reused: true };
  }

  for (const batch of checkpoint.batches) {
    if (batch.status !== 'planned') continue;
    await dependencies.providerGate.beforeCall('create_report', batch.requestKey);
    const requestedAt = workflowNow(dependencies).toISOString();
    const createdReport = await dependencies.api.createReport(batch.plan.request);
    if (!createdReport.reportId) {
      throw new SqpWorkflowPermanentError('SP-API created an SQP report without an id');
    }
    batch.reportId = createdReport.reportId;
    batch.status = 'requested';
    batch.createdByWorkflow = true;
    batch.requestedAt = requestedAt;
    await dependencies.checkpoints.save(checkpoint);
  }

  for (const batch of checkpoint.batches) {
    if (batch.status !== 'requested') continue;
    if (batch.reportId === null) {
      throw new SqpWorkflowPermanentError('requested SQP checkpoint has no report id');
    }
    await dependencies.providerGate.beforeCall('get_report', batch.requestKey);
    const report = await dependencies.api.getReport(batch.reportId);
    if (report.reportId !== batch.reportId) {
      throw new SqpWorkflowPermanentError('SP-API returned a different SQP report id');
    }
    if (report.reportType !== null && report.reportType !== SQP_REPORT_TYPE) {
      throw new SqpWorkflowPermanentError('SP-API returned a different report type');
    }
    const providerCreatedAt = parseProviderTimestamp(report.createdTime, 'createdTime');
    if (
      batch.providerCreatedAt !== null &&
      providerCreatedAt !== null &&
      batch.providerCreatedAt !== providerCreatedAt
    ) {
      throw new SqpWorkflowPermanentError('SP-API changed the SQP report created timestamp');
    }
    if (providerCreatedAt !== null) batch.providerCreatedAt = providerCreatedAt;
    if (batch.requestedAt === null) {
      batch.requestedAt = providerCreatedAt ?? workflowNow(dependencies).toISOString();
    }
    switch (report.processingStatus) {
      case 'IN_QUEUE':
      case 'IN_PROGRESS':
        break;
      case 'DONE':
        if (report.reportDocumentId === null) {
          throw new SqpWorkflowPermanentError('completed SQP report has no document id');
        }
        batch.reportDocumentId = report.reportDocumentId;
        batch.status = 'ready';
        batch.completedAt = workflowNow(dependencies).toISOString();
        break;
      case 'CANCELLED':
        // Amazon documents two indistinguishable causes: manual cancellation
        // and automatic no-data. Never delete canonical rows on status alone.
        if (
          !batch.createdByWorkflow ||
          await dependencies.confirmCancelledNoData?.({ batch, report }) !== true
        ) {
          throw new SqpWorkflowPermanentError(
            'cancelled SQP report lacks authoritative no-data confirmation',
          );
        }
        batch.status = 'empty';
        batch.reportDocumentId = null;
        batch.completedAt = workflowNow(dependencies).toISOString();
        break;
      case 'FATAL':
        throw new SqpWorkflowPermanentError(`SQP report ${batch.reportId} failed fatally`);
      default:
        throw new SqpWorkflowPermanentError(
          `SQP report ${batch.reportId} returned unknown status ${report.processingStatus}`,
        );
    }
    await dependencies.checkpoints.save(checkpoint);
  }

  if (checkpoint.batches.some((batch) => batch.status === 'planned' || batch.status === 'requested')) {
    return pendingResult(checkpoint, dependencies.nextPollAfterSeconds ?? 300);
  }

  const parsedReports: ParsedSqpReport[] = [];
  for (const batch of checkpoint.batches) {
    if (batch.status === 'empty') {
      parsedReports.push(parseSqpReport(
        { dataByAsin: [] },
        parsingContext(payload, batch),
      ));
      continue;
    }
    if (batch.status !== 'ready' || batch.reportDocumentId === null) {
      throw new SqpWorkflowPermanentError('SQP checkpoint reached an impossible terminal state');
    }
    await dependencies.providerGate.beforeCall('get_report_document', batch.requestKey);
    const document = await dependencies.api.getReportDocument(batch.reportDocumentId);
    if (document.reportDocumentId !== batch.reportDocumentId) {
      throw new SqpWorkflowPermanentError('SP-API returned a different SQP document id');
    }
    await dependencies.providerGate.beforeCall('download_report_document', batch.requestKey);
    const payloadDocument = await dependencies.api.downloadReportDocument(document);
    parsedReports.push(parseSqpReport(payloadDocument, parsingContext(payload, batch)));
  }

  const merged = mergeParsedReports(parsedReports);
  if (merged.counts.refusedRows > 0) {
    throw new SqpWorkflowPermanentError(
      `SQP report refused ${merged.counts.refusedRows} rows; canonical promotion is blocked`,
    );
  }
  const vocabulary = await dependencies.data.listVocabulary({
    orgId: payload.orgId,
    marketplaceId: payload.marketplaceId,
  });
  const categorized = merged.rows.map((row) => ({
    ...row,
    category: classifyQuery({
      searchQuery: row.searchQuery,
      marketplaceId: row.marketplaceId,
      vocabulary,
    }).category,
  }));
  const sourceReports = promotionSourceReports(checkpoint);
  const requestedAt = new Date(Math.min(...sourceReports.map((report) => report.requestedAt.valueOf())));
  const completedAt = new Date(Math.max(...sourceReports.map((report) => report.completedAt.valueOf())));
  const requestIdentity = promotionRequestIdentity(payload, sourceReports);
  const ingestion = await dependencies.data.promoteFacts({
    orgId: payload.orgId,
    profileId: payload.profileId,
    marketplaceId: payload.marketplaceId,
    weekStart: payload.weekStart,
    weekEnd: payload.weekEnd,
    requestedAsins: plans.flatMap((plan) => plan.asins),
    requestIdentity,
    requestedAt,
    completedAt,
    sourceReports,
    rows: categorized,
    counts: { ...merged.counts, upserts: categorized.length },
  });

  const ppcRecords = await dependencies.data.listPpcFacts({
    orgId: payload.orgId,
    profileId: payload.profileId,
    marketplaceId: payload.marketplaceId,
    weekStart: payload.weekStart,
    weekEnd: payload.weekEnd,
  });
  const ppcFacts = ppcRecords.map(toPpcFact);
  const joined = joinSqpAndPpc(categorized, ppcFacts);
  const conservation = verifySpendConservation(ppcFacts, joined);
  if (!conservation.conserved) {
    throw new SqpWorkflowPermanentError('SQP/PPC join duplicated or lost spend');
  }
  const recordsById = new Map(ppcRecords.map((record) => [record.id, record]));
  const proposals: ContextualNegativeProposal[] = [];
  for (const row of joined) {
    const ppc = recordsById.get(row.ppc.id);
    if (!ppc) throw new SqpWorkflowPermanentError('SQP/PPC join lost its source row');
    const category = row.sqp?.category ?? classifyQuery({
      searchQuery: ppc.searchTerm,
      marketplaceId: ppc.marketplaceId,
      vocabulary,
    }).category;
    const routing = dependencies.resolveRouting?.({ ppc, category }) ?? null;
    if (routing === null) continue;
    if (ppc.groupRole !== routing.sourceGroupRole) {
      throw new SqpWorkflowPermanentError('routing decision disagrees with the persisted group role');
    }
    const proposal = proposeContextualNegative({
      profileId: ppc.profileId,
      marketplaceId: ppc.marketplaceId,
      campaignId: ppc.campaignId,
      adGroupId: ppc.adGroupId,
      searchTerm: ppc.searchTerm,
      category,
      sourceGroupRole: routing.sourceGroupRole,
      policy: routing.policy,
    });
    if (proposal !== null) proposals.push(proposal);
  }
  const proposalCounts = await dependencies.data.persistProposals({
    orgId: payload.orgId,
    profileId: payload.profileId,
    proposals,
  });

  const categories = rollupQueryCategories(categorized.map((row) => ({
    category: row.category,
    value: row.searchQueryVolume,
  })));
  const result: CompletedSqpWorkflowResult = {
    status: 'completed',
    runKey,
    reused: false,
    reports: {
      total: checkpoint.batches.length,
      created: checkpoint.batches.filter((batch) => batch.createdByWorkflow).length,
      reusedCompleted: checkpoint.batches.filter((batch) => !batch.createdByWorkflow).length,
      empty: checkpoint.batches.filter((batch) => batch.status === 'empty').length,
    },
    ingestion,
    categories,
    joins: {
      asinExact: joined.filter((row) => row.attribution === 'asin_exact').length,
      profileOnly: joined.filter((row) => row.attribution === 'profile_only').length,
      ambiguous: joined.filter((row) => row.attribution === 'ambiguous').length,
      unmatched: joined.filter((row) => row.attribution === 'unmatched').length,
      inputRows: conservation.inputRows,
      outputRows: conservation.outputRows,
      inputSpend: conservation.inputSpend,
      outputSpend: conservation.outputSpend,
    },
    proposals: proposalCounts,
  };
  checkpoint.completed = result;
  await dependencies.checkpoints.save(checkpoint);
  return result;
}

export class InMemorySqpWorkflowCheckpoints implements SqpWorkflowCheckpointStore {
  private readonly rows = new Map<string, SqpWorkflowCheckpoint>();

  async load(runKey: string): Promise<SqpWorkflowCheckpoint | null> {
    const value = this.rows.get(runKey);
    return value === undefined ? null : structuredClone(value);
  }

  async save(checkpoint: SqpWorkflowCheckpoint): Promise<void> {
    this.rows.set(checkpoint.runKey, structuredClone(checkpoint));
  }
}

const SQP_CHECKPOINT_RESULT_KIND = 'sqp_workflow_checkpoint';
const SQP_CHECKPOINT_RESULT_VERSION = 1;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Durable queue-owned checkpoint storage. `finish_sync_job` deliberately keeps
 * an existing result when a retry supplies no replacement, so this envelope
 * survives the pending-error/requeue transition without a schema change.
 */
export class PostgresSqpWorkflowCheckpoints implements SqpWorkflowCheckpointStore {
  constructor(
    private readonly handle: DbHandle,
    private readonly owner: {
      jobId: string;
      orgId: string;
      profileId: string;
    },
  ) {}

  async load(runKey: string): Promise<SqpWorkflowCheckpoint | null> {
    const rows = await this.handle.sql<{ result: unknown }[]>`
      select result
        from public.sync_jobs
       where id = ${this.owner.jobId}
         and org_id = ${this.owner.orgId}
         and profile_id = ${this.owner.profileId}
         and job_type = 'sqp.request'::public.sync_job_type
         and status = 'running'::public.sync_job_status
    `;
    const row = rows[0];
    if (!row) {
      throw new SqpWorkflowPermanentError('SQP checkpoint job ownership could not be verified');
    }
    if (row.result === null) return null;
    return decodeCheckpointEnvelope(row.result, runKey);
  }

  async save(checkpoint: SqpWorkflowCheckpoint): Promise<void> {
    const envelope = {
      kind: SQP_CHECKPOINT_RESULT_KIND,
      version: SQP_CHECKPOINT_RESULT_VERSION,
      checkpoint,
    };
    const rows = await this.handle.sql<{ id: string }[]>`
      update public.sync_jobs
         set result = ${JSON.stringify(envelope)}::jsonb
       where id = ${this.owner.jobId}
         and org_id = ${this.owner.orgId}
         and profile_id = ${this.owner.profileId}
         and job_type = 'sqp.request'::public.sync_job_type
         and status = 'running'::public.sync_job_status
      returning id
    `;
    if (rows.length !== 1 || rows[0]?.id !== this.owner.jobId) {
      throw new SqpWorkflowPermanentError('SQP checkpoint write did not update its owning job');
    }
  }
}

function decodeCheckpointEnvelope(value: unknown, runKey: string): SqpWorkflowCheckpoint {
  if (!isRecord(value)) {
    throw new SqpWorkflowPermanentError('SQP checkpoint result is not an object');
  }
  if (
    value['kind'] !== SQP_CHECKPOINT_RESULT_KIND ||
    value['version'] !== SQP_CHECKPOINT_RESULT_VERSION
  ) {
    throw new SqpWorkflowPermanentError('SQP checkpoint result has an unsupported envelope');
  }
  const checkpoint = value['checkpoint'];
  if (
    !isRecord(checkpoint) ||
    checkpoint['runKey'] !== runKey ||
    typeof checkpoint['orgId'] !== 'string' ||
    typeof checkpoint['profileId'] !== 'string' ||
    typeof checkpoint['marketplaceId'] !== 'string' ||
    typeof checkpoint['weekStart'] !== 'string' ||
    typeof checkpoint['weekEnd'] !== 'string' ||
    !Array.isArray(checkpoint['batches']) ||
    !(checkpoint['completed'] === null || isRecord(checkpoint['completed']))
  ) {
    throw new SqpWorkflowPermanentError('SQP checkpoint result is malformed');
  }
  return structuredClone(checkpoint) as unknown as SqpWorkflowCheckpoint;
}

export class PostgresSqpWorkflowDataStore implements SqpWorkflowDataStore {
  constructor(private readonly handle: DbHandle) {}

  listVocabulary(input: { orgId: string; marketplaceId: string }): Promise<QueryVocabularyEntry[]> {
    return listQueryVocabulary(this.handle, input);
  }

  promoteFacts(input: SqpWeeklyPromotionInput): Promise<SqpWeeklyPromotionResult> {
    return promoteSqpWeeklyFacts(this.handle, input);
  }

  listPpcFacts(input: {
    orgId: string;
    profileId: string;
    marketplaceId: string;
    weekStart: string;
    weekEnd: string;
  }): Promise<WeeklyPpcQueryRecord[]> {
    return readWeeklyPpcQueryFacts(this.handle, input);
  }

  persistProposals(input: {
    orgId: string;
    profileId: string;
    proposals: readonly ContextualNegativeProposal[];
  }): Promise<ContextualProposalPersistenceCounts> {
    return persistContextualNegativeProposals(this.handle, input);
  }
}

export interface PostgresSqpRequestHandlerOptions {
  handle: DbHandle;
  api: SqpReportApi;
  providerGate: SqpProviderGate;
  /** Test seam; production always uses the tenant-scoped Postgres store. */
  data?: SqpWorkflowDataStore;
  resolveRouting?: SqpWorkflowDependencies['resolveRouting'];
  confirmCancelledNoData?: SqpWorkflowDependencies['confirmCancelledNoData'];
  nextPollAfterSeconds?: number;
  now?: () => Date;
}

/** Build the queue handler once SP-API token custody is available to a runtime. */
export function createPostgresSqpRequestHandler(options: PostgresSqpRequestHandlerOptions): (
  payload: SqpRequestJobType,
  context: SqpQueuedJobContext,
) => Promise<Record<string, unknown>> {
  const data = options.data ?? new PostgresSqpWorkflowDataStore(options.handle);
  return async (payload, context) => {
    const checkpoints = new PostgresSqpWorkflowCheckpoints(options.handle, {
      jobId: context.jobId,
      orgId: payload.orgId,
      profileId: payload.profileId,
    });
    const result = await runSqpRequestWorkflow(payload, {
      api: options.api,
      providerGate: options.providerGate,
      checkpoints,
      data,
      ...(options.resolveRouting === undefined ? {} : { resolveRouting: options.resolveRouting }),
      ...(options.confirmCancelledNoData === undefined
        ? {}
        : { confirmCancelledNoData: options.confirmCancelledNoData }),
      ...(options.nextPollAfterSeconds === undefined
        ? {}
        : { nextPollAfterSeconds: options.nextPollAfterSeconds }),
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    if (result.status === 'pending') {
      throw new SqpWorkflowPendingError(result.nextPollAfterSeconds);
    }
    return { ...result };
  };
}

/** Serial provider gate; the Reports API default rate is intentionally slow. */
export class MinimumIntervalSqpProviderGate implements SqpProviderGate {
  private lastCallAt = Number.NEGATIVE_INFINITY;
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly minimumIntervalMs: number,
    private readonly now: () => number = Date.now,
    private readonly sleep: (milliseconds: number) => Promise<void> =
      (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  ) {
    if (!Number.isFinite(minimumIntervalMs) || minimumIntervalMs < 0) {
      throw new Error('minimum SQP provider interval must be non-negative');
    }
  }

  beforeCall(_operation: SqpProviderOperation, _requestKey: string): Promise<void> {
    const turn = this.tail.then(async () => {
      const remaining = this.lastCallAt + this.minimumIntervalMs - this.now();
      if (remaining > 0) await this.sleep(remaining);
      this.lastCallAt = this.now();
    });
    this.tail = turn.catch(() => {});
    return turn;
  }
}

function workflowKey(payload: SqpRequestJobType, plans: readonly SqpReportRequestPlan[]): string {
  return `sqp:${createHash('sha256').update([
    payload.orgId,
    payload.profileId,
    payload.marketplaceId,
    payload.weekStart,
    payload.weekEnd,
    ...plans.map((plan) => plan.requestKey),
  ].join('\u0000')).digest('hex')}`;
}

function promotionRequestIdentity(
  payload: SqpRequestJobType,
  reports: readonly SqpSourceReportMetadata[],
): string {
  return `sqp-source:${createHash('sha256').update([
    payload.orgId,
    payload.profileId,
    payload.marketplaceId,
    payload.weekStart,
    payload.weekEnd,
    ...[...reports]
      .sort((left, right) => left.requestKey.localeCompare(right.requestKey))
      .flatMap((report) => [
        report.requestKey,
        report.reportId,
        report.reportDocumentId ?? 'no-document',
        ...report.requestedAsins,
      ]),
  ].join('\u0000')).digest('hex')}`;
}

function promotionSourceReports(checkpoint: SqpWorkflowCheckpoint): SqpSourceReportMetadata[] {
  return checkpoint.batches.map((batch) => {
    if (
      (batch.status !== 'ready' && batch.status !== 'empty') ||
      batch.reportId === null ||
      batch.requestedAt === null ||
      batch.completedAt === null
    ) {
      throw new SqpWorkflowPermanentError('SQP source metadata is incomplete at promotion');
    }
    return {
      requestKey: batch.requestKey,
      reportId: batch.reportId,
      reportDocumentId: batch.reportDocumentId,
      requestedAt: new Date(batch.requestedAt),
      completedAt: new Date(batch.completedAt),
      providerCreatedAt: batch.providerCreatedAt === null ? null : new Date(batch.providerCreatedAt),
      requestedAsins: batch.plan.asins,
    };
  });
}

function workflowNow(dependencies: Pick<SqpWorkflowDependencies, 'now'>): Date {
  const value = dependencies.now?.() ?? new Date();
  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) {
    throw new SqpWorkflowPermanentError('SQP workflow clock returned an invalid timestamp');
  }
  return new Date(value);
}

function parseProviderTimestamp(value: string | null, field: string): string | null {
  if (value === null) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) {
    throw new SqpWorkflowPermanentError(`SP-API returned an invalid SQP report ${field}`);
  }
  return parsed.toISOString();
}

function validOptionalTimestamp(value: string | null): boolean {
  return value === null || !Number.isNaN(new Date(value).valueOf());
}

function freshCheckpoint(
  runKey: string,
  payload: SqpRequestJobType,
  plans: readonly SqpReportRequestPlan[],
): SqpWorkflowCheckpoint {
  return {
    runKey,
    orgId: payload.orgId,
    profileId: payload.profileId,
    marketplaceId: payload.marketplaceId,
    weekStart: payload.weekStart,
    weekEnd: payload.weekEnd,
    batches: plans.map((plan) => ({
      requestKey: plan.requestKey,
      plan,
      status: 'planned',
      reportId: null,
      reportDocumentId: null,
      createdByWorkflow: false,
      requestedAt: null,
      providerCreatedAt: null,
      completedAt: null,
    })),
    completed: null,
  };
}

function validateCheckpoint(
  checkpoint: SqpWorkflowCheckpoint,
  payload: SqpRequestJobType,
  plans: readonly SqpReportRequestPlan[],
): void {
  if (
    checkpoint.orgId !== payload.orgId ||
    checkpoint.profileId !== payload.profileId ||
    checkpoint.marketplaceId !== payload.marketplaceId ||
    checkpoint.weekStart !== payload.weekStart ||
    checkpoint.weekEnd !== payload.weekEnd ||
    checkpoint.batches.length !== plans.length ||
    checkpoint.batches.some((batch, index) =>
      batch.requestKey !== plans[index]?.requestKey ||
      JSON.stringify(batch.plan) !== JSON.stringify(plans[index]),
    )
  ) {
    throw new SqpWorkflowPermanentError('SQP checkpoint does not match its request');
  }
  for (const batch of checkpoint.batches) {
    if (
      !['planned', 'requested', 'ready', 'empty'].includes(batch.status) ||
      typeof batch.createdByWorkflow !== 'boolean' ||
      (batch.status === 'planned' && (batch.reportId !== null || batch.reportDocumentId !== null)) ||
      (batch.status === 'planned' &&
        (batch.requestedAt !== null || batch.providerCreatedAt !== null || batch.completedAt !== null)) ||
      (batch.status === 'requested' && (batch.reportId === null || batch.requestedAt === null)) ||
      (batch.status === 'requested' && batch.completedAt !== null) ||
      (batch.status === 'ready' &&
        (batch.reportId === null || batch.reportDocumentId === null ||
          batch.requestedAt === null || batch.completedAt === null)) ||
      (batch.status === 'empty' &&
        (batch.reportId === null || batch.requestedAt === null || batch.completedAt === null)) ||
      !validOptionalTimestamp(batch.requestedAt) ||
      !validOptionalTimestamp(batch.providerCreatedAt) ||
      !validOptionalTimestamp(batch.completedAt)
    ) {
      throw new SqpWorkflowPermanentError('SQP checkpoint contains an invalid batch state');
    }
    if (
      batch.requestedAt !== null &&
      batch.completedAt !== null &&
      new Date(batch.completedAt) < new Date(batch.requestedAt)
    ) {
      throw new SqpWorkflowPermanentError('SQP checkpoint completed before it was requested');
    }
  }
  if (
    checkpoint.completed !== null &&
    (checkpoint.completed.status !== 'completed' || checkpoint.completed.runKey !== checkpoint.runKey)
  ) {
    throw new SqpWorkflowPermanentError('SQP checkpoint contains an invalid completed result');
  }
}

function pendingResult(
  checkpoint: SqpWorkflowCheckpoint,
  nextPollAfterSeconds: number,
): PendingSqpWorkflowResult {
  if (!Number.isInteger(nextPollAfterSeconds) || nextPollAfterSeconds < 1) {
    throw new Error('next SQP poll delay must be a positive integer');
  }
  return {
    status: 'pending',
    runKey: checkpoint.runKey,
    reports: {
      total: checkpoint.batches.length,
      planned: checkpoint.batches.filter((batch) => batch.status === 'planned').length,
      requested: checkpoint.batches.filter((batch) => batch.status === 'requested').length,
      ready: checkpoint.batches.filter((batch) => batch.status === 'ready').length,
      empty: checkpoint.batches.filter((batch) => batch.status === 'empty').length,
    },
    nextPollAfterSeconds,
  };
}

function parsingContext(payload: SqpRequestJobType, batch: SqpBatchCheckpoint): {
  profileId: string;
  marketplaceId: string;
  expectedWeekStart: string;
  expectedWeekEnd: string;
  expectedAsins: readonly string[];
} {
  return {
    profileId: payload.profileId,
    marketplaceId: payload.marketplaceId,
    expectedWeekStart: payload.weekStart,
    expectedWeekEnd: payload.weekEnd,
    expectedAsins: batch.plan.asins,
  };
}

function mergeParsedReports(reports: readonly ParsedSqpReport[]): {
  rows: SqpWeeklyFact[];
  counts: SqpIngestionCounts;
} {
  const rows = reports.flatMap((report) => report.rows);
  const seen = new Set<string>();
  for (const row of rows) {
    const key = [row.profileId, row.marketplaceId, row.weekStart, row.asin, row.normalizedQuery].join('\u0000');
    if (seen.has(key)) {
      throw new SqpWorkflowPermanentError('SQP batches overlap on a normalized canonical grain');
    }
    seen.add(key);
  }
  const counts = reports.reduce<SqpIngestionCounts>((total, report) => ({
    sourceAsins: total.sourceAsins + report.counts.sourceAsins,
    sourceRows: total.sourceRows + report.counts.sourceRows,
    parsedRows: total.parsedRows + report.counts.parsedRows,
    deduplicatedRows: total.deduplicatedRows + report.counts.deduplicatedRows,
    refusedRows: total.refusedRows + report.counts.refusedRows,
    upserts: total.upserts + report.counts.upserts,
  }), {
    sourceAsins: 0,
    sourceRows: 0,
    parsedRows: 0,
    deduplicatedRows: 0,
    refusedRows: 0,
    upserts: 0,
  });
  if (
    counts.sourceRows !== counts.parsedRows + counts.refusedRows ||
    counts.deduplicatedRows !== rows.length
  ) {
    throw new SqpWorkflowPermanentError('merged SQP report counts do not reconcile');
  }
  return { rows, counts: { ...counts, upserts: rows.length } };
}

function toPpcFact(row: WeeklyPpcQueryRecord): PpcQueryFact {
  return {
    id: row.id,
    profileId: row.profileId,
    marketplaceId: row.marketplaceId,
    weekStart: row.weekStart,
    searchTerm: row.searchTerm,
    asin: row.asin,
    attributedAsins: row.attributedAsins,
    spend: row.spend,
    sales: row.sales,
    clicks: row.clicks,
    orders: row.orders,
  };
}

// Kept as a named result for callers that persist weekly AI suggestions before
// an operator approves them. The workflow itself reads; it never auto-approves.
export type SqpSuggestionPersistenceCounts = VocabularyPersistenceCounts;
