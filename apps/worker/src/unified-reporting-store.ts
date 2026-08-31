import { randomUUID } from 'node:crypto';
import type { DbHandle, QuerySql } from '@wizard-ads/db';
import {
  UnifiedReportOperation,
  UnifiedReportRun,
  type UnifiedReportAdvanceJob,
  type UnifiedReportOperation as UnifiedReportOperationShape,
  type UnifiedReportOperationDisposition,
  type UnifiedReportRun as UnifiedReportRunShape,
  type UnifiedReportRunState,
} from '@wizard-ads/shared';
import type {
  UnifiedBeginResult,
  UnifiedDualRunStore,
  UnifiedSettlement,
} from './unified-reporting.js';

type RunRow = {
  id: string;
  org_id: string;
  profile_id: string;
  v3_report_request_id: string;
  binding_id: string;
  advertiser_account_id: string;
  report_type: 'spCampaigns';
  definition_version: 'campaign-observation-v1';
  start_date: string;
  end_date: string;
  state: UnifiedReportRunState;
  provider_report_id: string | null;
  provider_status: string | null;
  observation_deadline: Date | string;
  operation_count: number | string;
  settled_operation_count: number | string;
  input_count: number | string;
  provider_success_count: number | string;
  provider_refused_count: number | string;
  create_ambiguous_count: number | string;
  transport_failure_count: number | string;
  invalid_response_count: number | string;
  local_refusal_count: number | string;
  interrupted_dispatch_count: number | string;
  created_at: Date | string;
  updated_at: Date | string;
};

type OperationRow = {
  id: string;
  org_id: string;
  profile_id: string;
  run_id: string;
  dispatch_job_id: string;
  kind: 'create' | 'retrieve';
  sequence: number | string;
  state: 'ready' | 'dispatching' | 'settled';
  disposition: UnifiedReportOperationDisposition | null;
  dispatch_token: string | null;
  dispatched_at: Date | string | null;
  settled_at: Date | string | null;
  provider_code: string | null;
  input_count: number | string;
  provider_success_count: number | string;
  provider_refused_count: number | string;
  create_ambiguous_count: number | string;
  transport_failure_count: number | string;
  invalid_response_count: number | string;
  local_refusal_count: number | string;
  interrupted_dispatch_count: number | string;
  created_at: Date | string;
  updated_at: Date | string;
};

type LockedLifecycle = {
  run: UnifiedReportRunShape;
  operation: UnifiedReportOperationShape;
  bindingEnabled: boolean | null;
};

const DISPOSITION_COLUMNS = {
  provider_success: 'provider_success_count',
  provider_refused: 'provider_refused_count',
  create_ambiguous: 'create_ambiguous_count',
  transport_failure: 'transport_failure_count',
  invalid_response: 'invalid_response_count',
  local_refusal: 'local_refusal_count',
  interrupted_dispatch: 'interrupted_dispatch_count',
} as const satisfies Record<UnifiedReportOperationDisposition, string>;

/**
 * Postgres owns every state/queue transition. Provider I/O happens only after
 * `begin` commits a dispatch fence, and a successor queue row is committed in
 * the same transaction as the operation it follows.
 */
export class PostgresUnifiedDualRunStore implements UnifiedDualRunStore {
  constructor(private readonly handle: Pick<DbHandle, 'sql'>) {}

  async admit(input: {
    v3ReportRequestId: string;
    orgId: string;
    profileId: string;
    reportType: 'spCampaigns';
    definitionVersion: 'campaign-observation-v1';
    startDate: string;
    endDate: string;
    observationDeadline: Date;
    now: Date;
  }): Promise<
    | { kind: 'binding_unavailable' }
    | { kind: 'enqueued'; runId: string; operationId: string; inserted: boolean }
  > {
    return this.handle.sql.begin(async (sql) => {
      await sql`set local lock_timeout = '250ms'`;
      await sql`set local statement_timeout = '2s'`;
      const bindings = await sql<{
        id: string;
        advertiser_account_id: string;
        definition_version: 'campaign-observation-v1';
      }[]>`
        select id, advertiser_account_id, definition_version
          from public.unified_reporting_bindings
         where org_id = ${input.orgId}
           and profile_id = ${input.profileId}
           and enabled
         for share nowait
      `;
      const binding = bindings[0];
      if (!binding || binding.definition_version !== input.definitionVersion) {
        return { kind: 'binding_unavailable' as const };
      }

      const requests = await sql<{ id: string }[]>`
        select r.id
          from public.report_requests r
         where r.id = ${input.v3ReportRequestId}
           and r.org_id = ${input.orgId}
           and r.profile_id = ${input.profileId}
           and r.report_type = ${input.reportType}::public.report_type
           and r.start_date = ${input.startDate}::date
           and r.end_date = ${input.endDate}::date
           and r.source = 'amazon_api'
           and r.amazon_report_id is not null
           and exists (
             select 1
               from public.sync_jobs j
              where j.org_id = r.org_id
                and j.profile_id = r.profile_id
                and j.job_type = 'report.poll'::public.sync_job_type
                and j.payload ->> 'type' = 'report.poll'
                and j.payload ->> 'reportRequestId' = r.id::text
                and j.payload ->> 'amazonReportId' = r.amazon_report_id
           )
         for share nowait
      `;
      if (requests.length !== 1) {
        throw new Error(
          'Unified sidecar admission requires one durable matching v3 request and poll job',
        );
      }

      const runId = randomUUID();
      const operationId = randomUUID();
      const jobId = randomUUID();
      const runs = await sql<{ id: string }[]>`
        insert into public.unified_report_runs (
          id, org_id, profile_id, v3_report_request_id, binding_id,
          advertiser_account_id, report_type, definition_version,
          start_date, end_date, state, observation_deadline,
          operation_count, input_count, created_at, updated_at
        ) values (
          ${runId}, ${input.orgId}, ${input.profileId}, ${input.v3ReportRequestId}, ${binding.id},
          ${binding.advertiser_account_id}, ${input.reportType}::public.report_type,
          ${input.definitionVersion}::public.unified_report_definition_version,
          ${input.startDate}::date, ${input.endDate}::date,
          'create_ready'::public.unified_report_run_state,
          ${iso(input.observationDeadline)}::timestamptz,
          1, 1, ${iso(input.now)}::timestamptz, ${iso(input.now)}::timestamptz
        )
        on conflict (v3_report_request_id) do nothing
        returning id
      `;

      if (runs.length === 0) {
        const existing = await loadExistingAdmission(sql, input);
        return {
          kind: 'enqueued' as const,
          runId: existing.runId,
          operationId: existing.operationId,
          inserted: false,
        };
      }
      assertOneId(runs, runId, 'Unified run admission');

      const payload: UnifiedReportAdvanceJob = {
        type: 'report.unified.advance',
        orgId: input.orgId,
        profileId: input.profileId,
        runId,
        operationId,
      };
      await insertOperationAndJob(sql, {
        jobId,
        operationId,
        runId,
        orgId: input.orgId,
        profileId: input.profileId,
        kind: 'create',
        sequence: 0,
        runAt: input.now,
        payload,
      });
      return { kind: 'enqueued' as const, runId, operationId, inserted: true };
    });
  }

  async begin(input: {
    jobId: string;
    payload: UnifiedReportAdvanceJob;
    now: Date;
  }): Promise<UnifiedBeginResult> {
    return this.handle.sql.begin(async (sql) => {
      await sql`set local lock_timeout = '250ms'`;
      await sql`set local statement_timeout = '2s'`;
      const locked = await loadLocked(sql, input.payload, input.jobId);
      if (locked === null) {
        return { kind: 'settled' as const, runState: 'local_failed' as const };
      }
      if (locked.operation.state === 'settled') {
        return { kind: 'settled' as const, runState: locked.run.state };
      }

      if (
        locked.operation.state === 'ready' &&
        input.now >= new Date(locked.run.observationDeadline)
      ) {
        const runState = locked.operation.kind === 'retrieve'
          ? 'observation_horizon_reached' as const
          : 'local_failed' as const;
        await settleClosed(
          sql,
          locked,
          input.now,
          'local_refusal',
          runState,
        );
        return {
          kind: 'recovered' as const,
          runState,
          successorEnqueued: false,
        };
      }

      if (locked.bindingEnabled !== true) {
        const recovered = await closeWithoutDispatch(sql, locked, input.now, 'paused');
        return { kind: 'recovered' as const, ...recovered };
      }

      if (locked.operation.state === 'ready') {
        const dispatchToken = randomUUID();
        const operations = await sql<{ id: string }[]>`
          update public.unified_report_operations
             set state = 'dispatching'::public.unified_report_operation_state,
                 dispatch_token = ${dispatchToken},
                 dispatched_at = ${iso(input.now)}::timestamptz,
                 updated_at = ${iso(input.now)}::timestamptz
           where id = ${locked.operation.id}
             and state = 'ready'::public.unified_report_operation_state
          returning id
        `;
        assertOneId(operations, locked.operation.id, 'Unified dispatch fence');
        if (locked.operation.kind === 'create') {
          const runs = await sql<{ id: string }[]>`
            update public.unified_report_runs
               set state = 'create_dispatching'::public.unified_report_run_state,
                   updated_at = ${iso(input.now)}::timestamptz
             where id = ${locked.run.id}
               and state = 'create_ready'::public.unified_report_run_state
            returning id
          `;
          assertOneId(runs, locked.run.id, 'Unified create dispatch state');
        }
        const refreshed = await loadLocked(sql, input.payload, input.jobId);
        if (refreshed === null) {
          throw new Error('Unified dispatch fence disappeared inside its transaction');
        }
        return {
          kind: 'dispatch' as const,
          value: {
            run: refreshed.run,
            operation: refreshed.operation,
            dispatchToken,
          },
        };
      }

      const recovered = await recoverInterruptedDispatch(sql, locked, input.now);
      return { kind: 'recovered' as const, ...recovered };
    });
  }

  async settle(input: UnifiedSettlement): Promise<{
    runState: UnifiedReportRunState;
    successorEnqueued: boolean;
  }> {
    return this.handle.sql.begin(async (sql) => {
      const locked = await loadLockedByIds(sql, input.runId, input.operationId);
      if (locked === null) {
        return { runState: 'local_failed' as const, successorEnqueued: false };
      }
      if (locked.operation.state === 'settled') {
        if (
          locked.operation.kind === 'create' &&
          locked.operation.disposition === 'create_ambiguous' &&
          locked.operation.dispatchToken === input.dispatchToken &&
          input.disposition !== 'create_ambiguous'
        ) {
          return strengthenCreateAmbiguity(sql, locked, input);
        }
        if (locked.operation.dispatchToken !== input.dispatchToken) {
          throw new Error('Unified settlement does not match its durable dispatch fence');
        }
        return { runState: locked.run.state, successorEnqueued: false };
      }
      if (
        locked.operation.state !== 'dispatching' ||
        locked.operation.dispatchToken !== input.dispatchToken
      ) {
        throw new Error('Unified settlement does not match its durable dispatch fence');
      }
      validateSettlement(locked, input);
      const providerCode = bounded(input.providerCode, 128);
      const providerReportId = bounded(input.providerReportId, 256);
      const providerStatus = bounded(input.providerStatus, 256);
      await settleOperation(sql, locked.operation, input.disposition, providerCode, input.now);

      const runs = await sql<{ id: string }[]>`
        update public.unified_report_runs
           set state = ${input.runState}::public.unified_report_run_state,
               provider_report_id = coalesce(${providerReportId ?? null}, provider_report_id),
               provider_status = coalesce(${providerStatus ?? null}, provider_status),
               settled_operation_count = settled_operation_count + 1,
               provider_success_count = provider_success_count
                 + (${input.disposition} = 'provider_success')::integer,
               provider_refused_count = provider_refused_count
                 + (${input.disposition} = 'provider_refused')::integer,
               create_ambiguous_count = create_ambiguous_count
                 + (${input.disposition} = 'create_ambiguous')::integer,
               transport_failure_count = transport_failure_count
                 + (${input.disposition} = 'transport_failure')::integer,
               invalid_response_count = invalid_response_count
                 + (${input.disposition} = 'invalid_response')::integer,
               local_refusal_count = local_refusal_count
                 + (${input.disposition} = 'local_refusal')::integer,
               interrupted_dispatch_count = interrupted_dispatch_count
                 + (${input.disposition} = 'interrupted_dispatch')::integer,
               updated_at = ${iso(input.now)}::timestamptz
         where id = ${locked.run.id}
        returning id
      `;
      assertOneId(runs, locked.run.id, 'Unified run settlement');

      const successorEnqueued = input.nextRunAt === undefined
        ? false
        : await appendRetrieve(sql, locked.run, locked.operation.sequence + 1, input.nextRunAt, input.now);
      return { runState: input.runState, successorEnqueued };
    });
  }

  async failTerminal(input: {
    payload: UnifiedReportAdvanceJob;
    reason: string;
    runState: Extract<UnifiedReportRunState, 'paused' | 'local_failed'>;
    now: Date;
  }): Promise<void> {
    // `reason` is deliberately not persisted: queue finalization owns its
    // bounded diagnostic, while this public ledger stores only closed classes.
    void input.reason;
    await this.handle.sql.begin(async (sql) => {
      const locked = await loadLockedByIds(sql, input.payload.runId, input.payload.operationId);
      if (locked === null) return;
      if (
        locked.run.orgId !== input.payload.orgId ||
        locked.run.profileId !== input.payload.profileId ||
        locked.operation.state === 'settled'
      ) return;
      await closeWithoutDispatch(sql, locked, input.now, input.runState);
    });
  }
}

async function loadExistingAdmission(
  sql: QuerySql,
  input: {
    v3ReportRequestId: string;
    orgId: string;
    profileId: string;
    reportType: 'spCampaigns';
    definitionVersion: 'campaign-observation-v1';
    startDate: string;
    endDate: string;
  },
): Promise<{ runId: string; operationId: string }> {
  const rows = await sql<{ run_id: string; operation_id: string }[]>`
    select r.id as run_id, o.id as operation_id
      from public.unified_report_runs r
      join public.unified_report_operations o
        on o.org_id = r.org_id and o.profile_id = r.profile_id and o.run_id = r.id
       and o.kind = 'create'::public.unified_report_operation_kind
     where r.v3_report_request_id = ${input.v3ReportRequestId}
       and r.org_id = ${input.orgId}
       and r.profile_id = ${input.profileId}
       and r.report_type = ${input.reportType}::public.report_type
       and r.definition_version = ${input.definitionVersion}::public.unified_report_definition_version
       and r.start_date = ${input.startDate}::date
       and r.end_date = ${input.endDate}::date
  `;
  const row = rows[0];
  if (!row || rows.length !== 1) {
    throw new Error('Existing Unified admission does not match the requested v3 scope');
  }
  return { runId: row.run_id, operationId: row.operation_id };
}

async function loadLocked(
  sql: QuerySql,
  payload: UnifiedReportAdvanceJob,
  jobId: string,
): Promise<LockedLifecycle | null> {
  const loaded = await loadLockedByIds(sql, payload.runId, payload.operationId);
  if (loaded === null) return null;
  if (
    loaded.run.orgId !== payload.orgId ||
    loaded.run.profileId !== payload.profileId ||
    loaded.operation.dispatchJobId !== jobId
  ) {
    throw new Error('Unified queue job does not match its tenant-scoped operation');
  }
  return loaded;
}

async function loadLockedByIds(
  sql: QuerySql,
  runId: string,
  operationId: string,
): Promise<LockedLifecycle | null> {
  const rows = await sql<(RunRow & {
    binding_enabled: boolean | null;
    operation_json: OperationRow;
  })[]>`
    select r.id, r.org_id, r.profile_id, r.v3_report_request_id, r.binding_id,
           r.advertiser_account_id, r.report_type, r.definition_version,
           r.start_date::text, r.end_date::text, r.state, r.provider_report_id,
           r.provider_status, r.observation_deadline, r.operation_count,
           r.settled_operation_count, r.input_count, r.provider_success_count,
           r.provider_refused_count, r.create_ambiguous_count,
           r.transport_failure_count, r.invalid_response_count,
           r.local_refusal_count, r.interrupted_dispatch_count,
           r.created_at, r.updated_at, b.enabled as binding_enabled,
           to_jsonb(o) as operation_json
      from public.unified_report_runs r
      join public.unified_report_operations o
        on o.org_id = r.org_id and o.profile_id = r.profile_id and o.run_id = r.id
      left join public.unified_reporting_bindings b
        on b.org_id = r.org_id and b.profile_id = r.profile_id and b.id = r.binding_id
     where r.id = ${runId}
       and o.id = ${operationId}
     for update of r, o nowait
  `;
  const row = rows[0];
  if (!row) return null;
  if (rows.length !== 1) throw new Error('Unified run operation is not unique');
  return {
    run: parseRun(row),
    operation: parseOperation(row.operation_json),
    bindingEnabled: row.binding_enabled,
  };
}

async function recoverInterruptedDispatch(
  sql: QuerySql,
  locked: { run: UnifiedReportRunShape; operation: UnifiedReportOperationShape },
  now: Date,
): Promise<{ runState: UnifiedReportRunState; successorEnqueued: boolean }> {
  if (locked.operation.kind === 'create') {
    await settleClosed(sql, locked, now, 'create_ambiguous', 'create_ambiguous');
    return { runState: 'create_ambiguous', successorEnqueued: false };
  }
  const beforeDeadline = now < new Date(locked.run.observationDeadline);
  const runState: UnifiedReportRunState = beforeDeadline
    ? 'observing'
    : 'observation_horizon_reached';
  await settleClosed(sql, locked, now, 'interrupted_dispatch', runState);
  const successorEnqueued = beforeDeadline
    ? await appendRetrieve(sql, locked.run, locked.operation.sequence + 1, now, now)
    : false;
  return { runState, successorEnqueued };
}

async function closeWithoutDispatch(
  sql: QuerySql,
  locked: { run: UnifiedReportRunShape; operation: UnifiedReportOperationShape },
  now: Date,
  requestedState: Extract<UnifiedReportRunState, 'paused' | 'local_failed'>,
): Promise<{ runState: UnifiedReportRunState; successorEnqueued: false }> {
  if (locked.operation.state === 'settled') {
    return { runState: locked.run.state, successorEnqueued: false };
  }
  const disposition: UnifiedReportOperationDisposition = locked.operation.state === 'ready'
    ? 'local_refusal'
    : locked.operation.kind === 'create'
      ? 'create_ambiguous'
      : 'interrupted_dispatch';
  const runState: UnifiedReportRunState = disposition === 'create_ambiguous'
    ? 'create_ambiguous'
    : requestedState;
  await settleClosed(sql, locked, now, disposition, runState);
  return { runState, successorEnqueued: false };
}

async function settleClosed(
  sql: QuerySql,
  locked: { run: UnifiedReportRunShape; operation: UnifiedReportOperationShape },
  now: Date,
  disposition: UnifiedReportOperationDisposition,
  runState: UnifiedReportRunState,
): Promise<void> {
  await settleOperation(sql, locked.operation, disposition, undefined, now);
  const rows = await sql<{ id: string }[]>`
    update public.unified_report_runs
       set state = ${runState}::public.unified_report_run_state,
           settled_operation_count = settled_operation_count + 1,
           provider_success_count = provider_success_count
             + (${disposition} = 'provider_success')::integer,
           provider_refused_count = provider_refused_count
             + (${disposition} = 'provider_refused')::integer,
           create_ambiguous_count = create_ambiguous_count
             + (${disposition} = 'create_ambiguous')::integer,
           transport_failure_count = transport_failure_count
             + (${disposition} = 'transport_failure')::integer,
           invalid_response_count = invalid_response_count
             + (${disposition} = 'invalid_response')::integer,
           local_refusal_count = local_refusal_count
             + (${disposition} = 'local_refusal')::integer,
           interrupted_dispatch_count = interrupted_dispatch_count
             + (${disposition} = 'interrupted_dispatch')::integer,
           updated_at = ${iso(now)}::timestamptz
     where id = ${locked.run.id}
    returning id
  `;
  assertOneId(rows, locked.run.id, 'Unified terminal run close');
}

async function strengthenCreateAmbiguity(
  sql: QuerySql,
  locked: { run: UnifiedReportRunShape; operation: UnifiedReportOperationShape },
  input: UnifiedSettlement,
): Promise<{ runState: UnifiedReportRunState; successorEnqueued: boolean }> {
  if (!['provider_success', 'provider_refused', 'invalid_response'].includes(input.disposition)) {
    throw new Error('Late Unified create settlement does not strengthen ambiguity');
  }
  if (
    input.disposition === 'invalid_response' &&
    (
      input.runState !== 'local_failed' ||
      input.providerReportId !== undefined ||
      input.providerStatus !== undefined
    )
  ) {
    throw new Error('Late invalid Unified create result cannot retain untrusted provider identity');
  }
  validateSettlement(locked, input);
  const providerCode = bounded(input.providerCode, 128);
  const providerReportId = bounded(input.providerReportId, 256);
  const providerStatus = bounded(input.providerStatus, 256);
  const column = DISPOSITION_COLUMNS[input.disposition];
  const operations = await sql<{ id: string }[]>`
    update public.unified_report_operations
       set disposition = ${input.disposition}::public.unified_report_operation_disposition,
           settled_at = ${iso(input.now)}::timestamptz,
           provider_code = ${providerCode ?? null},
           provider_success_count = case when ${column} = 'provider_success_count' then 1 else 0 end,
           provider_refused_count = case when ${column} = 'provider_refused_count' then 1 else 0 end,
           create_ambiguous_count = 0,
           invalid_response_count = case when ${column} = 'invalid_response_count' then 1 else 0 end,
           updated_at = ${iso(input.now)}::timestamptz
     where id = ${locked.operation.id}
       and state = 'settled'::public.unified_report_operation_state
       and disposition = 'create_ambiguous'::public.unified_report_operation_disposition
       and dispatch_token = ${input.dispatchToken}
    returning id
  `;
  assertOneId(operations, locked.operation.id, 'Unified late create strengthening');
  const runs = await sql<{ id: string }[]>`
    update public.unified_report_runs
       set state = ${input.runState}::public.unified_report_run_state,
           provider_report_id = coalesce(${providerReportId ?? null}, provider_report_id),
           provider_status = coalesce(${providerStatus ?? null}, provider_status),
           provider_success_count = provider_success_count
             + (${input.disposition} = 'provider_success')::integer,
           provider_refused_count = provider_refused_count
             + (${input.disposition} = 'provider_refused')::integer,
           create_ambiguous_count = create_ambiguous_count - 1,
           invalid_response_count = invalid_response_count
             + (${input.disposition} = 'invalid_response')::integer,
           updated_at = ${iso(input.now)}::timestamptz
     where id = ${locked.run.id}
       and state = 'create_ambiguous'::public.unified_report_run_state
       and create_ambiguous_count > 0
    returning id
  `;
  assertOneId(runs, locked.run.id, 'Unified late create run strengthening');
  const successorEnqueued = input.nextRunAt === undefined
    ? false
    : await appendRetrieve(
        sql,
        { ...locked.run, providerReportId: providerReportId ?? locked.run.providerReportId },
        locked.operation.sequence + 1,
        input.nextRunAt,
        input.now,
      );
  return { runState: input.runState, successorEnqueued };
}

async function settleOperation(
  sql: QuerySql,
  operation: UnifiedReportOperationShape,
  disposition: UnifiedReportOperationDisposition,
  providerCode: string | undefined,
  now: Date,
): Promise<void> {
  const column = DISPOSITION_COLUMNS[disposition];
  const rows = await sql<{ id: string }[]>`
    update public.unified_report_operations
       set state = 'settled'::public.unified_report_operation_state,
           disposition = ${disposition}::public.unified_report_operation_disposition,
           settled_at = ${iso(now)}::timestamptz,
           provider_code = ${providerCode ?? null},
           provider_success_count = case when ${column} = 'provider_success_count' then 1 else 0 end,
           provider_refused_count = case when ${column} = 'provider_refused_count' then 1 else 0 end,
           create_ambiguous_count = case when ${column} = 'create_ambiguous_count' then 1 else 0 end,
           transport_failure_count = case when ${column} = 'transport_failure_count' then 1 else 0 end,
           invalid_response_count = case when ${column} = 'invalid_response_count' then 1 else 0 end,
           local_refusal_count = case when ${column} = 'local_refusal_count' then 1 else 0 end,
           interrupted_dispatch_count = case when ${column} = 'interrupted_dispatch_count' then 1 else 0 end,
           updated_at = ${iso(now)}::timestamptz
     where id = ${operation.id}
       and state = ${operation.state}::public.unified_report_operation_state
    returning id
  `;
  assertOneId(rows, operation.id, 'Unified operation settlement');
}

async function appendRetrieve(
  sql: QuerySql,
  run: UnifiedReportRunShape,
  sequence: number,
  runAt: Date,
  now: Date,
): Promise<boolean> {
  const operationId = randomUUID();
  const jobId = randomUUID();
  const payload: UnifiedReportAdvanceJob = {
    type: 'report.unified.advance',
    orgId: run.orgId,
    profileId: run.profileId,
    runId: run.id,
    operationId,
  };
  await insertOperationAndJob(sql, {
    jobId,
    operationId,
    runId: run.id,
    orgId: run.orgId,
    profileId: run.profileId,
    kind: 'retrieve',
    sequence,
    runAt,
    payload,
  });
  const rows = await sql<{ id: string }[]>`
    update public.unified_report_runs
       set operation_count = operation_count + 1,
           input_count = input_count + 1,
           updated_at = ${iso(now)}::timestamptz
     where id = ${run.id}
    returning id
  `;
  assertOneId(rows, run.id, 'Unified successor accounting');
  return true;
}

async function insertOperationAndJob(
  sql: QuerySql,
  input: {
    jobId: string;
    operationId: string;
    runId: string;
    orgId: string;
    profileId: string;
    kind: 'create' | 'retrieve';
    sequence: number;
    runAt: Date;
    payload: UnifiedReportAdvanceJob;
  },
): Promise<void> {
  const jobs = await sql<{ id: string }[]>`
    insert into public.sync_jobs
      (id, org_id, profile_id, job_type, payload, run_after, dedupe_key)
    values
      (${input.jobId}, ${input.orgId}, ${input.profileId},
       'report.unified.advance'::public.sync_job_type,
       ${JSON.stringify(input.payload)}::jsonb,
       ${iso(input.runAt)}::timestamptz,
       ${`report.unified.advance:${input.runId}:${input.sequence}`})
    returning id
  `;
  assertOneId(jobs, input.jobId, 'Unified queue insertion');
  const operations = await sql<{ id: string }[]>`
    insert into public.unified_report_operations (
      id, org_id, profile_id, run_id, dispatch_job_id, kind, sequence
    ) values (
      ${input.operationId}, ${input.orgId}, ${input.profileId}, ${input.runId}, ${input.jobId},
      ${input.kind}::public.unified_report_operation_kind, ${input.sequence}
    )
    returning id
  `;
  assertOneId(operations, input.operationId, 'Unified operation insertion');
}

function validateSettlement(
  locked: { run: UnifiedReportRunShape; operation: UnifiedReportOperationShape },
  input: UnifiedSettlement,
): void {
  const allowed = locked.operation.kind === 'create'
    ? (
        (input.disposition === 'provider_success' && ['observing', 'provider_status_observed', 'observation_horizon_reached'].includes(input.runState)) ||
        (input.disposition === 'provider_refused' && input.runState === 'create_refused') ||
        (input.disposition === 'create_ambiguous' && input.runState === 'create_ambiguous') ||
        (input.disposition === 'invalid_response' && ['contract_blocked', 'local_failed'].includes(input.runState))
      )
    : (
        (input.disposition === 'provider_success' && ['observing', 'provider_status_observed', 'observation_horizon_reached'].includes(input.runState)) ||
        (input.disposition === 'provider_refused' && input.runState === 'retrieve_refused') ||
        (input.disposition === 'transport_failure' && ['observing', 'observation_horizon_reached'].includes(input.runState)) ||
        (input.disposition === 'invalid_response' && ['contract_blocked', 'local_failed'].includes(input.runState))
      );
  if (!allowed) throw new Error('Unified operation disposition and run state do not agree');
  if (input.disposition === 'local_refusal') {
    throw new Error('A fenced Unified dispatch cannot settle as a local refusal');
  }
  if (input.disposition === 'create_ambiguous' && locked.operation.kind !== 'create') {
    throw new Error('Only a Unified create can settle as ambiguous');
  }
  if (
    locked.run.providerReportId !== null &&
    input.providerReportId !== undefined &&
    input.providerReportId.trim() !== locked.run.providerReportId
  ) {
    throw new Error('Unified retrieve settlement cannot change its provider report id');
  }
  if (input.nextRunAt !== undefined) {
    if (input.runState !== 'observing' || input.nextRunAt >= new Date(locked.run.observationDeadline)) {
      throw new Error('Unified successor must remain inside the observation horizon');
    }
    if (locked.operation.kind === 'create' && input.disposition !== 'provider_success') {
      throw new Error('Only a successful Unified create can schedule its first retrieve');
    }
    if (
      locked.operation.kind === 'retrieve' &&
      input.disposition !== 'provider_success' &&
      input.disposition !== 'transport_failure'
    ) {
      throw new Error('Unified retrieve successor follows only observation or transport failure');
    }
  }
  const reportId = input.providerReportId ?? locked.run.providerReportId;
  const providerStatus = input.providerStatus ?? locked.run.providerStatus;
  if ((reportId === null) !== (providerStatus === null)) {
    throw new Error('Unified provider report id and observed status must be stored together');
  }
  if (
    ['observing', 'retrieve_refused', 'provider_status_observed', 'contract_blocked',
      'observation_horizon_reached'].includes(input.runState) && reportId === null
  ) {
    throw new Error('Unified settlement state requires a provider report id');
  }
  if (
    ['create_ready', 'create_dispatching', 'create_refused', 'create_ambiguous'].includes(input.runState) &&
    reportId !== null
  ) {
    throw new Error('Unified create terminal state cannot carry a provider report id');
  }
}

function parseRun(row: RunRow): UnifiedReportRunShape {
  return UnifiedReportRun.parse({
    id: row.id,
    orgId: row.org_id,
    profileId: row.profile_id,
    v3ReportRequestId: row.v3_report_request_id,
    bindingId: row.binding_id,
    advertiserAccountId: row.advertiser_account_id,
    reportType: row.report_type,
    definitionVersion: row.definition_version,
    startDate: row.start_date,
    endDate: row.end_date,
    state: row.state,
    providerReportId: row.provider_report_id,
    providerStatus: row.provider_status,
    observationDeadline: asIso(row.observation_deadline),
    accounting: {
      operationCount: Number(row.operation_count),
      settledOperationCount: Number(row.settled_operation_count),
      inputCount: Number(row.input_count),
      providerSuccessCount: Number(row.provider_success_count),
      providerRefusedCount: Number(row.provider_refused_count),
      createAmbiguousCount: Number(row.create_ambiguous_count),
      transportFailureCount: Number(row.transport_failure_count),
      invalidResponseCount: Number(row.invalid_response_count),
      localRefusalCount: Number(row.local_refusal_count),
      interruptedDispatchCount: Number(row.interrupted_dispatch_count),
    },
    createdAt: asIso(row.created_at),
    updatedAt: asIso(row.updated_at),
  });
}

function parseOperation(row: OperationRow): UnifiedReportOperationShape {
  return UnifiedReportOperation.parse({
    id: row.id,
    orgId: row.org_id,
    profileId: row.profile_id,
    runId: row.run_id,
    dispatchJobId: row.dispatch_job_id,
    kind: row.kind,
    sequence: Number(row.sequence),
    state: row.state,
    disposition: row.disposition,
    dispatchToken: row.dispatch_token,
    dispatchedAt: row.dispatched_at === null ? null : asIso(row.dispatched_at),
    settledAt: row.settled_at === null ? null : asIso(row.settled_at),
    providerCode: row.provider_code,
    accounting: {
      inputCount: Number(row.input_count),
      providerSuccessCount: Number(row.provider_success_count),
      providerRefusedCount: Number(row.provider_refused_count),
      createAmbiguousCount: Number(row.create_ambiguous_count),
      transportFailureCount: Number(row.transport_failure_count),
      invalidResponseCount: Number(row.invalid_response_count),
      localRefusalCount: Number(row.local_refusal_count),
      interruptedDispatchCount: Number(row.interrupted_dispatch_count),
    },
    createdAt: asIso(row.created_at),
    updatedAt: asIso(row.updated_at),
  });
}

function bounded(value: string | undefined, maximum: number): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > maximum) {
    throw new Error(`Unified provider field must contain 1-${maximum} characters`);
  }
  return normalized;
}

function iso(value: Date): string {
  return value.toISOString();
}

function asIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function assertOneId(rows: readonly { id: string }[], expected: string, operation: string): void {
  if (rows.length !== 1 || rows[0]?.id !== expected) {
    throw new Error(`${operation} did not write exactly one expected row`);
  }
}
