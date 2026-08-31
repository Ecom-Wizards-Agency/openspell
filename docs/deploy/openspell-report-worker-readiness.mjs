#!/usr/bin/env node

import { clearTimeout, setTimeout } from 'node:timers';

const DEFAULT_TIMEOUT_MS = 5_000;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 10_000;
const SANITIZED_FAILURE = 'OpenSpell report worker database readiness failed';

/**
 * Prove the worker database and queue contract without claiming or changing a row.
 * The injected handle factory exists only so refusal paths can exercise the real policy
 * without a database. Production always uses the packaged @wizard-ads/db client.
 */
export async function verifyReportWorkerDatabaseReadiness({
  databaseUrl,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  createHandle,
}) {
  if (typeof databaseUrl !== 'string' || databaseUrl.length === 0) {
    throw new Error(SANITIZED_FAILURE);
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < MIN_TIMEOUT_MS || timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error(SANITIZED_FAILURE);
  }
  if (typeof createHandle !== 'function') throw new Error(SANITIZED_FAILURE);

  let handle;
  try {
    handle = createHandle(databaseUrl);
    const result = await withDeadline(
      handle.sql.begin('read only', async (sql) => {
        const [contract] = await sql`
          with queue_contract as (
            select
              to_regtype('public.sync_job_type') as queue_type,
              to_regprocedure(
                'public.claim_sync_jobs(text,integer,public.sync_job_type[])'
              ) as claim_function
          )
          select
            current_setting('transaction_read_only') = 'on' as transaction_read_only,
            app.is_service_role() as service_role_ready,
            to_regclass('public.sync_jobs') is not null as queue_relation_ready,
            queue_type is not null as queue_type_ready,
            claim_function is not null as claim_function_ready,
            has_table_privilege(
              current_user, 'public.sync_jobs', 'SELECT'
            ) as queue_read_ready,
            coalesce(
              has_type_privilege(current_user, queue_type, 'USAGE'), false
            ) as queue_type_access_ready,
            coalesce(
              has_function_privilege(current_user, claim_function, 'EXECUTE'), false
            ) as claim_execute_ready
          from queue_contract
        `;
        await sql`select id from public.sync_jobs limit 0`;
        return contract;
      }),
      timeoutMs,
    );
    if (
      result?.transaction_read_only !== true
      || result?.service_role_ready !== true
      || result?.queue_relation_ready !== true
      || result?.queue_type_ready !== true
      || result?.claim_function_ready !== true
      || result?.queue_read_ready !== true
      || result?.queue_type_access_ready !== true
      || result?.claim_execute_ready !== true
    ) {
      throw new Error(SANITIZED_FAILURE);
    }
  } catch {
    throw new Error(SANITIZED_FAILURE);
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
