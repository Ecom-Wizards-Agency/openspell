#!/usr/bin/env node

import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import process from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';
import { pathToFileURL } from 'node:url';

const DEFAULT_TIMEOUT_MS = 5_000;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 10_000;
const MAX_DATABASE_URL_BYTES = 8_192;
const SANITIZED_FAILURE = 'OpenSpell report worker database readiness failed';
const CUSTODY_FAILURE = 'OpenSpell report worker claim custody proof failed';

const READY_FIELDS = [
  'transaction_read_only',
  'service_role_ready',
  'queue_relation_ready',
  'queue_type_ready',
  'claim_token_column_ready',
  'claim_token_index_ready',
  'fenced_claim_ready',
  'fenced_finish_ready',
  'fenced_defer_ready',
  'fenced_grants_ready',
  'legacy_guards_ready',
  'queue_read_ready',
  'queue_type_access_ready',
];

/** Prove the complete fenced queue contract without claiming or changing a row. */
export async function verifyReportWorkerDatabaseReadiness({
  databaseUrl,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  createHandle,
}) {
  validateInputs(databaseUrl, timeoutMs, createHandle, SANITIZED_FAILURE);

  await withHandle(databaseUrl, timeoutMs, createHandle, SANITIZED_FAILURE, async (handle) => {
    const result = await withDeadline(
      handle.sql.begin('read only', async (sql) => {
        const [contract] = await sql`
          with queue_contract as (
            select
              to_regtype('public.sync_job_type') as queue_type,
              to_regprocedure(
                'public.claim_sync_jobs_fenced(text,integer,public.sync_job_type[])'
              ) as fenced_claim,
              to_regprocedure(
                'public.finish_sync_job_fenced(uuid,uuid,public.sync_job_status,text,jsonb,interval)'
              ) as fenced_finish,
              to_regprocedure(
                'public.defer_sync_job_fenced(uuid,uuid,interval)'
              ) as fenced_defer,
              to_regprocedure('public.claim_sync_jobs(text,integer)') as legacy_claim,
              to_regprocedure(
                'public.claim_sync_jobs(text,integer,public.sync_job_type[])'
              ) as legacy_filtered_claim,
              to_regprocedure(
                'public.finish_sync_job(uuid,public.sync_job_status,text,jsonb,interval)'
              ) as legacy_finish,
              to_regprocedure('public.requeue_stale_sync_jobs(interval)') as legacy_reaper
          )
          select
            current_setting('transaction_read_only') = 'on' as transaction_read_only,
            app.is_service_role() as service_role_ready,
            to_regclass('public.sync_jobs') is not null as queue_relation_ready,
            queue_type is not null as queue_type_ready,
            exists (
              select 1
                from pg_catalog.pg_attribute a
               where a.attrelid = 'public.sync_jobs'::regclass
                 and a.attname = 'claim_token'
                 and a.atttypid = 'uuid'::regtype
                 and a.attnotnull = false
                 and a.atthasdef = false
                 and a.attnum > 0
                 and not a.attisdropped
            ) as claim_token_column_ready,
            coalesce((
              select i.indisunique
                 and i.indisvalid
                 and i.indnkeyatts = 1
                 and pg_get_indexdef(i.indexrelid, 1, true) = 'claim_token'
                 and pg_get_expr(i.indpred, i.indrelid) = '(claim_token IS NOT NULL)'
                from pg_catalog.pg_index i
               where i.indexrelid = to_regclass('public.sync_jobs_claim_token_key')
                 and i.indrelid = 'public.sync_jobs'::regclass
            ), false) as claim_token_index_ready,
            coalesce((
              select p.proretset
                 and p.prorettype = 'public.sync_jobs'::regtype
                 and p.prosecdef
                 and p.proconfig = array['search_path=pg_catalog, public, pg_temp']
                from pg_catalog.pg_proc p
               where p.oid = fenced_claim
            ), false) as fenced_claim_ready,
            coalesce((
              select p.proretset
                 and p.prorettype = 'record'::regtype
                 and p.prosecdef
                 and p.proconfig = array['search_path=pg_catalog, public, pg_temp']
                 and p.proallargtypes = array[
                   'uuid'::regtype, 'uuid'::regtype, 'public.sync_job_status'::regtype,
                   'text'::regtype, 'jsonb'::regtype, 'interval'::regtype,
                   'text'::regtype, 'public.sync_job_status'::regtype, 'integer'::regtype
                 ]::oid[]
                 and p.proargmodes = array['i','i','i','i','i','i','t','t','t']::"char"[]
                 and p.proargnames = array[
                   'p_job_id','p_claim_token','p_status','p_error','p_result','p_retry_in',
                   'decision','status','attempts'
                 ]
                from pg_catalog.pg_proc p
               where p.oid = fenced_finish
            ), false) as fenced_finish_ready,
            coalesce((
              select p.proretset
                 and p.prorettype = 'record'::regtype
                 and p.prosecdef
                 and p.proconfig = array['search_path=pg_catalog, public, pg_temp']
                 and p.proallargtypes = array[
                   'uuid'::regtype, 'uuid'::regtype, 'interval'::regtype,
                   'text'::regtype, 'public.sync_job_status'::regtype, 'integer'::regtype
                 ]::oid[]
                 and p.proargmodes = array['i','i','i','t','t','t']::"char"[]
                 and p.proargnames = array[
                   'p_job_id','p_claim_token','p_retry_in','decision','status','attempts'
                 ]
                from pg_catalog.pg_proc p
               where p.oid = fenced_defer
            ), false) as fenced_defer_ready,
            fenced_claim is not null
              and fenced_finish is not null
              and fenced_defer is not null
              and has_function_privilege(current_user, fenced_claim, 'EXECUTE')
              and has_function_privilege(current_user, fenced_finish, 'EXECUTE')
              and has_function_privilege(current_user, fenced_defer, 'EXECUTE')
              and has_function_privilege('service_role', fenced_claim, 'EXECUTE')
              and has_function_privilege('service_role', fenced_finish, 'EXECUTE')
              and has_function_privilege('service_role', fenced_defer, 'EXECUTE')
              and not has_function_privilege('anon', fenced_claim, 'EXECUTE')
              and not has_function_privilege('anon', fenced_finish, 'EXECUTE')
              and not has_function_privilege('anon', fenced_defer, 'EXECUTE')
              and not has_function_privilege('authenticated', fenced_claim, 'EXECUTE')
              and not has_function_privilege('authenticated', fenced_finish, 'EXECUTE')
              and not has_function_privilege('authenticated', fenced_defer, 'EXECUTE')
              and not exists (
                select 1
                  from pg_catalog.pg_proc p,
                       lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
                 where p.oid in (fenced_claim, fenced_finish, fenced_defer)
                   and acl.privilege_type = 'EXECUTE'
                   and acl.grantee not in (p.proowner, 'service_role'::regrole)
              ) as fenced_grants_ready,
            legacy_claim is not null
              and legacy_filtered_claim is not null
              and legacy_finish is not null
              and legacy_reaper is not null
              and position('claim_token is null' in lower(pg_get_functiondef(legacy_claim))) > 0
              and position('claim_token is null' in lower(pg_get_functiondef(legacy_filtered_claim))) > 0
              and position('claim_token is null' in lower(pg_get_functiondef(legacy_finish))) > 0
              and position('claim_token is null' in lower(pg_get_functiondef(legacy_reaper))) > 0
              as legacy_guards_ready,
            has_table_privilege(current_user, 'public.sync_jobs', 'SELECT') as queue_read_ready,
            coalesce(
              has_type_privilege(current_user, queue_type, 'USAGE'), false
            ) as queue_type_access_ready
          from queue_contract
        `;
        await sql`select id, claim_token from public.sync_jobs limit 0`;
        return contract;
      }),
      timeoutMs,
    );
    if (!READY_FIELDS.every((field) => result?.[field] === true)) {
      throw new Error(SANITIZED_FAILURE);
    }
  });
}

/** Return only a digest and unresolved count; no custody identifier leaves this helper. */
export async function captureReportWorkerClaimCustody({
  databaseUrl,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  createHandle,
}) {
  validateInputs(databaseUrl, timeoutMs, createHandle, CUSTODY_FAILURE);

  return withHandle(databaseUrl, timeoutMs, createHandle, CUSTODY_FAILURE, async (handle) => {
    const rows = await withDeadline(
      handle.sql.begin('read only', async (sql) => sql`
        select
          id, job_type, status, attempts, max_attempts, run_after,
          claimed_by, claimed_at, claim_token, started_at, finished_at,
          last_error, created_at, updated_at
        from public.sync_jobs
        where job_type = any(array[
          'creative.sync', 'report.request', 'report.poll', 'report.fetch'
        ]::public.sync_job_type[])
        order by id
      `),
      timeoutMs,
    );
    if (!Array.isArray(rows)) throw new Error(CUSTODY_FAILURE);
    const state = rows.map((row) => [
      row.id,
      row.job_type,
      row.status,
      row.attempts,
      row.max_attempts,
      timestampValue(row.run_after),
      row.claimed_by,
      timestampValue(row.claimed_at),
      row.claim_token,
      timestampValue(row.started_at),
      timestampValue(row.finished_at),
      row.last_error,
      timestampValue(row.created_at),
      timestampValue(row.updated_at),
    ]);
    const unresolved = rows.filter(
      (row) => row.status === 'running' || row.claim_token !== null,
    ).length;
    return Object.freeze({
      schemaVersion: 1,
      unresolved,
      fingerprint: createHash('sha256').update(JSON.stringify(state)).digest('hex'),
    });
  });
}

function timestampValue(value) {
  if (value === null) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  throw new Error(CUSTODY_FAILURE);
}

function validateInputs(databaseUrl, timeoutMs, createHandle, failure) {
  if (typeof databaseUrl !== 'string' || databaseUrl.length === 0) throw new Error(failure);
  if (!Number.isInteger(timeoutMs) || timeoutMs < MIN_TIMEOUT_MS || timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error(failure);
  }
  if (typeof createHandle !== 'function') throw new Error(failure);
}

async function withHandle(databaseUrl, timeoutMs, createHandle, failure, operation) {
  let handle;
  try {
    handle = createHandle(databaseUrl);
    return await operation(handle);
  } catch {
    throw new Error(failure);
  } finally {
    if (handle?.sql?.end) {
      await withDeadline(handle.sql.end({ timeout: 0 }), timeoutMs).catch(() => undefined);
    } else if (handle?.close) {
      await withDeadline(handle.close(), timeoutMs).catch(() => undefined);
    }
  }
}

function withDeadline(operation, timeoutMs) {
  let timeout;
  return Promise.race([
    operation,
    new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error(SANITIZED_FAILURE)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timeout));
}

async function runCommand() {
  const mode = process.argv[2];
  const rawDatabaseUrl = await readFile(0, 'utf8');
  if (Buffer.byteLength(rawDatabaseUrl, 'utf8') > MAX_DATABASE_URL_BYTES) {
    throw new Error(SANITIZED_FAILURE);
  }
  const databaseUrl = rawDatabaseUrl.trim();
  const { createDb } = await import('@wizard-ads/db');
  const createHandle = (connectionString) => createDb({
    connectionString,
    max: 1,
    statementTimeoutSeconds: 5,
  });
  if (mode === '--database-contract') {
    await verifyReportWorkerDatabaseReadiness({ databaseUrl, createHandle });
    return;
  }
  if (mode === '--custody-snapshot') {
    const snapshot = await captureReportWorkerClaimCustody({ databaseUrl, createHandle });
    process.stdout.write(`${JSON.stringify(snapshot)}\n`);
    return;
  }
  throw new Error(SANITIZED_FAILURE);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCommand().catch((error) => {
    const message = error?.message === CUSTODY_FAILURE ? CUSTODY_FAILURE : SANITIZED_FAILURE;
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
