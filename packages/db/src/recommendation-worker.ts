/**
 * Recommendation-only PostgreSQL facade.
 *
 * This subpath intentionally exposes no DbHandle, Drizzle database, raw SQL
 * tag, provider secret, general queue helper, or relation query. The direct
 * LOGIN role can reach only the reviewed SECURITY DEFINER RPCs below.
 */
import postgres from 'postgres';
import {
  claimedJobFromRaw,
  type ClaimRef,
  type ClaimedJob,
  type RawClaimedJobRow,
} from './queries/job-wire.js';

export type { ClaimRef, ClaimedJob } from './queries/job-wire.js';

const REVISION = /^[0-9a-f]{40}$/;
const WORKER_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;

export interface RecommendationWorkerIdentity {
  workerId: string;
  revision: string;
}

export interface RecommendationWorkerDatabaseOptions extends RecommendationWorkerIdentity {
  connectionString: string;
  statementTimeoutSeconds?: number;
}

export type RecommendationWorkerAuthority = Readonly<{
  protocol: 'legacy' | 'fenced';
  admission: 'legacy' | 'blocked' | 'scoped';
  epoch: number;
  authorizedRevision: string | null;
}>;

export type RecommendationCutoverEvidence = RecommendationWorkerAuthority & Readonly<{
  queuedJobs: number;
  runningJobs: number;
  tokenBearingJobs: number;
  invalidActiveScopes: number;
}>;

export type RecommendationSettlementDecision =
  | Readonly<{ decision: 'settled' }>
  | Readonly<{ decision: 'stale_claim' }>;

export interface RecommendationExecutionScope {
  orgId: string;
  profileId: string;
  runId: string;
  groupId?: string;
}

export interface RecommendationStartWire {
  decision: 'started' | 'already_succeeded';
  runData: unknown;
  profileData: unknown;
}

export interface RecommendationInputsWire {
  inputs: unknown;
  groupSafety: unknown;
}

export type RecommendationFailureWire = Readonly<{
  decision: 'failed' | 'already_succeeded';
  proposalsCount: number;
}>;

interface RawAuthority {
  protocol: string;
  admission: string;
  epoch: string | number;
  authorized_revision: string | null;
}

interface RawCutoverEvidence extends RawAuthority {
  queued_jobs: number;
  running_jobs: number;
  token_bearing_jobs: number;
  invalid_active_scopes: number;
}

interface RawSettlement {
  decision: string;
  status: string | null;
  attempts: number | null;
}

interface RawStart {
  decision: string;
  run_data: unknown;
  profile_data: unknown;
}

interface RawInputs {
  inputs: unknown;
  group_safety: unknown;
}

export class RecommendationWorkerDatabase {
  private readonly sql: postgres.Sql;
  private readonly identity: Readonly<RecommendationWorkerIdentity>;

  constructor(options: RecommendationWorkerDatabaseOptions) {
    if (!WORKER_ID.test(options.workerId)) throw new Error('invalid recommendation worker id');
    if (!REVISION.test(options.revision)) throw new Error('invalid recommendation worker revision');
    if (!/^postgres(?:ql)?:\/\//i.test(options.connectionString)) {
      throw new Error('recommendation worker requires a PostgreSQL connection URL');
    }
    this.identity = Object.freeze({ workerId: options.workerId, revision: options.revision });
    this.sql = postgres(options.connectionString, {
      max: 1,
      prepare: false,
      onnotice: () => {},
      connection: options.statementTimeoutSeconds === undefined
        ? {}
        : { statement_timeout: options.statementTimeoutSeconds * 1000 },
    });
  }

  async close(): Promise<void> {
    await this.sql.end({ timeout: 5 });
  }

  async getAuthority(): Promise<RecommendationWorkerAuthority> {
    const rows = await this.sql<RawAuthority[]>`
      select protocol, admission, epoch, authorized_revision
        from public.get_recommendation_worker_authority()
    `;
    return parseAuthorityRow(one(rows, 'recommendation authority'));
  }

  async getCutoverEvidence(): Promise<RecommendationCutoverEvidence> {
    const rows = await this.sql<RawCutoverEvidence[]>`
      select protocol, admission, epoch, authorized_revision,
             queued_jobs, running_jobs, token_bearing_jobs, invalid_active_scopes
        from public.get_recommendation_cutover_evidence()
    `;
    const row = one(rows, 'recommendation cutover evidence');
    const authority = parseAuthorityRow(row);
    const queuedJobs = count(row.queued_jobs, 'queued jobs');
    const runningJobs = count(row.running_jobs, 'running jobs');
    const tokenBearingJobs = count(row.token_bearing_jobs, 'token-bearing jobs');
    const invalidActiveScopes = count(row.invalid_active_scopes, 'invalid active scopes');
    return {
      ...authority,
      queuedJobs,
      runningJobs,
      tokenBearingJobs,
      invalidActiveScopes,
    };
  }

  async resumeOwned(identity: RecommendationWorkerIdentity): Promise<readonly ClaimedJob[]> {
    this.assertIdentity(identity);
    const rows = await this.sql<RawClaimedJobRow[]>`
      select id, org_id, profile_id, job_type, payload, attempts, max_attempts,
             dedupe_key, claimed_by, claim_token
        from public.resume_recommendation_jobs_fenced(
          ${identity.workerId}, ${identity.revision}
        )
    `;
    return rows.map(requireFencedJob);
  }

  async claim(identity: RecommendationWorkerIdentity, limit: 1): Promise<readonly ClaimedJob[]> {
    this.assertIdentity(identity);
    if (limit !== 1) throw new Error('recommendation worker claim limit must be one');
    const rows = await this.sql<RawClaimedJobRow[]>`
      select id, org_id, profile_id, job_type, payload, attempts, max_attempts,
             dedupe_key, claimed_by, claim_token
        from public.claim_recommendation_jobs_fenced(
          ${identity.workerId}, ${identity.revision}, ${limit}
        )
    `;
    return rows.map(requireFencedJob);
  }

  async finish(
    claim: ClaimRef,
    outcome: 'succeeded' | 'failed' | 'dead',
    options: { error?: string; result?: unknown; retryIn?: string } = {},
  ): Promise<RecommendationSettlementDecision> {
    const rows = await this.sql<RawSettlement[]>`
      select decision, status, attempts
        from public.finish_recommendation_job_fenced(
          ${claim.jobId}::uuid, ${claim.workerId}, ${claim.token}::uuid,
          ${this.identity.revision}, ${outcome}::public.sync_job_status,
          ${options.error ?? null},
          ${options.result === undefined ? null : serializeJson(options.result)}::jsonb,
          ${options.retryIn ?? null}::interval
        )
    `;
    return settlement(one(rows, 'recommendation finish'), 'settled');
  }

  async defer(claim: ClaimRef, retryIn: string): Promise<RecommendationSettlementDecision> {
    const rows = await this.sql<RawSettlement[]>`
      select decision, status, attempts
        from public.defer_recommendation_job_fenced(
          ${claim.jobId}::uuid, ${claim.workerId}, ${claim.token}::uuid,
          ${this.identity.revision}, ${retryIn}::interval
        )
    `;
    return settlement(one(rows, 'recommendation defer'), 'deferred');
  }

  async start(
    claim: ClaimRef,
    scope: RecommendationExecutionScope,
  ): Promise<RecommendationStartWire> {
    const rows = await this.sql<RawStart[]>`
      select decision, run_data, profile_data
        from public.start_recommendation_run_fenced(
          ${claim.jobId}::uuid, ${claim.workerId}, ${claim.token}::uuid,
          ${this.identity.revision}, ${scope.orgId}::uuid, ${scope.profileId}::uuid,
          ${scope.runId}::uuid, ${scope.groupId ?? null}::uuid
        )
    `;
    const row = one(rows, 'recommendation start');
    if (row.decision !== 'started' && row.decision !== 'already_succeeded') {
      throw new Error('recommendation start returned an invalid decision');
    }
    return { decision: row.decision, runData: row.run_data, profileData: row.profile_data };
  }

  async readInputs(
    claim: ClaimRef,
    scope: RecommendationExecutionScope,
    window: { start: string; end: string },
  ): Promise<RecommendationInputsWire> {
    const rows = await this.sql<RawInputs[]>`
      select inputs, group_safety
        from public.read_recommendation_inputs_fenced(
          ${claim.jobId}::uuid, ${claim.workerId}, ${claim.token}::uuid,
          ${this.identity.revision}, ${scope.orgId}::uuid, ${scope.profileId}::uuid,
          ${scope.runId}::uuid, ${scope.groupId ?? null}::uuid,
          ${window.start}::date, ${window.end}::date
        )
    `;
    const row = one(rows, 'recommendation inputs');
    return { inputs: row.inputs, groupSafety: row.group_safety };
  }

  async succeed(
    claim: ClaimRef,
    scope: RecommendationExecutionScope,
    completion: unknown,
  ): Promise<{ decision: 'succeeded' | 'already_succeeded'; proposalsCount: number }> {
    const rows = await this.sql<{ decision: string; proposals_count: number }[]>`
      select decision, proposals_count
        from public.succeed_recommendation_run_fenced(
          ${claim.jobId}::uuid, ${claim.workerId}, ${claim.token}::uuid,
          ${this.identity.revision}, ${scope.orgId}::uuid, ${scope.profileId}::uuid,
          ${scope.runId}::uuid, ${scope.groupId ?? null}::uuid,
          ${serializeJson(completion)}::jsonb
        )
    `;
    const row = one(rows, 'recommendation success');
    if (row.decision !== 'succeeded' && row.decision !== 'already_succeeded') {
      throw new Error('recommendation success returned an invalid decision');
    }
    const proposalsCount = Number(row.proposals_count);
    if (!Number.isSafeInteger(proposalsCount) || proposalsCount < 0) {
      throw new Error('recommendation success returned an invalid proposal count');
    }
    return { decision: row.decision, proposalsCount };
  }

  async fail(
    claim: ClaimRef,
    scope: RecommendationExecutionScope,
    error: string,
  ): Promise<RecommendationFailureWire> {
    const rows = await this.sql<{ decision: string; proposals_count: number }[]>`
      select decision, proposals_count from public.fail_recommendation_run_fenced(
        ${claim.jobId}::uuid, ${claim.workerId}, ${claim.token}::uuid,
        ${this.identity.revision}, ${scope.orgId}::uuid, ${scope.profileId}::uuid,
        ${scope.runId}::uuid, ${scope.groupId ?? null}::uuid, ${error}
      )
    `;
    const row = one(rows, 'recommendation failure');
    if (row.decision !== 'failed' && row.decision !== 'already_succeeded') {
      throw new Error('recommendation failure returned an invalid decision');
    }
    const proposalsCount = Number(row.proposals_count);
    if (!Number.isSafeInteger(proposalsCount) || proposalsCount < 0) {
      throw new Error('recommendation failure returned an invalid proposal count');
    }
    return { decision: row.decision, proposalsCount };
  }

  private assertIdentity(identity: RecommendationWorkerIdentity): void {
    if (identity.workerId !== this.identity.workerId || identity.revision !== this.identity.revision) {
      throw new Error('recommendation worker identity changed after connection setup');
    }
  }
}

function requireFencedJob(row: RawClaimedJobRow): ClaimedJob {
  const job = claimedJobFromRaw(row);
  if (job.claim === null) throw new Error('recommendation claim returned tokenless custody');
  return job;
}

function settlement(row: RawSettlement, success: 'settled' | 'deferred'): RecommendationSettlementDecision {
  if (row.decision === 'stale_claim' && row.status === null && row.attempts === null) {
    return { decision: 'stale_claim' };
  }
  if (row.decision !== success || row.status === null || row.attempts === null) {
    throw new Error('recommendation settlement returned an invalid decision');
  }
  return { decision: 'settled' };
}

function one<T>(rows: readonly T[], name: string): T {
  const row = rows[0];
  if (rows.length !== 1 || row === undefined) throw new Error(`${name} returned an invalid row count`);
  return row;
}

function parseAuthorityRow(row: RawAuthority): RecommendationWorkerAuthority {
  if ((row.protocol !== 'legacy' && row.protocol !== 'fenced')
      || !['legacy', 'blocked', 'scoped'].includes(row.admission)) {
    throw new Error('recommendation authority returned an invalid state');
  }
  const epoch = Number(row.epoch);
  if (!Number.isSafeInteger(epoch) || epoch < 0) {
    throw new Error('recommendation authority returned an invalid epoch');
  }
  if (row.authorized_revision !== null && !REVISION.test(row.authorized_revision)) {
    throw new Error('recommendation authority returned an invalid revision');
  }
  return {
    protocol: row.protocol,
    admission: row.admission as RecommendationWorkerAuthority['admission'],
    epoch,
    authorizedRevision: row.authorized_revision,
  };
}

function count(value: number, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`recommendation cutover evidence returned invalid ${name}`);
  }
  return parsed;
}

function serializeJson(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error('value is not JSON serializable');
  return serialized;
}
