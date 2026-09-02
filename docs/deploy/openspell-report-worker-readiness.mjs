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
const AUTHORITY_FAILURE = 'OpenSpell report worker claim authority proof failed';
const ACTIVATION_FAILURE = 'OpenSpell report worker claim authority activation failed';

const READY_FIELDS = [
  'transaction_read_only',
  'service_role_ready',
  'queue_relation_ready',
  'queue_type_ready',
  'queue_status_type_ready',
  'claim_token_column_ready',
  'claim_token_index_ready',
  'claim_token_acl_ready',
  'authority_relation_ready',
  'queue_read_ready',
  'queue_type_access_ready',
];

export const REPORT_WORKER_FUNCTION_CONTRACTS = Object.freeze([
  ['legacy_claim_unfiltered', 'v', 'a3685aee2c73015dca2d8d7e890691557814559c79efbb78fcc0153fe31eab53'],
  ['legacy_claim_filtered', 'v', 'cc9b0bcf8adedf2dbabfaf7462cca7d6bfcecde8db23e1d53ffa45453d559776'],
  ['legacy_finish', 'v', '073d8e69b987e9573f9c80d04eea0fb29d7687b43aaedbc1a97bf4fda062f79a'],
  ['legacy_reaper', 'v', 'a847a2035a740fed0cb2d28ea79d78f4b8a496e32badd0f6943cda8080437d48'],
  ['fenced_claim', 'v', '5fe012a1138cbd44c28081b6a9ca81767bb4c39911593b17019785e59a56647a'],
  ['fenced_finish', 'v', 'e9ab6bb3c0baf1846bb88c8499e4c92d471fb8420ba33fc7e0150398e60b79e9'],
  ['fenced_defer', 'v', '0d21e1d5ae5ce1b7e478a48dbeebbe11b44e493c530feee9300a87800c39dbed'],
  ['authority_get', 's', 'b943f648b5c5597b66f8e0475b0e7f9c20fc14749bbfdd0b70939021c1e2c5eb'],
  ['authority_activate', 'v', 'a242fde73dc9627a0e4d0ef6ff58a97e89cc78f00136862e89e9efcab67b00c9'],
].map(([key, volatility, sourceHash]) => Object.freeze({ key, volatility, sourceHash })));

export const REPORT_WORKER_AUTHORITY_CONSTRAINTS = Object.freeze([
  Object.freeze({
    name: 'report_worker_claim_authority_epoch_check',
    type: 'c',
    columnNumbers: Object.freeze([3]),
    columnNames: Object.freeze(['epoch']),
    definition: 'CHECK (epoch >= 0)',
  }),
  Object.freeze({
    name: 'report_worker_claim_authority_pkey',
    type: 'p',
    columnNumbers: Object.freeze([1]),
    columnNames: Object.freeze(['singleton']),
    definition: 'PRIMARY KEY (singleton)',
  }),
  Object.freeze({
    name: 'report_worker_claim_authority_protocol_check',
    type: 'c',
    columnNumbers: Object.freeze([2]),
    columnNames: Object.freeze(['protocol']),
    definition: "CHECK (protocol = ANY (ARRAY['legacy'::text, 'fenced'::text]))",
  }),
  Object.freeze({
    name: 'report_worker_claim_authority_singleton_check',
    type: 'c',
    columnNumbers: Object.freeze([1]),
    columnNames: Object.freeze(['singleton']),
    definition: 'CHECK (singleton)',
  }),
]);

/** Prove the complete fenced queue contract without claiming or changing a row. */
export async function verifyReportWorkerDatabaseReadiness({
  databaseUrl,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  createHandle,
  functionContracts = REPORT_WORKER_FUNCTION_CONTRACTS,
}) {
  validateInputs(databaseUrl, timeoutMs, createHandle, SANITIZED_FAILURE);
  validateFunctionContracts(functionContracts);

  await withHandle(databaseUrl, timeoutMs, createHandle, SANITIZED_FAILURE, async (handle) => {
    const [result, functions] = await withDeadline(
      handle.sql.begin('read only', async (sql) => {
        const [contract] = await sql`
          with queue_contract as (
            select
              to_regtype('public.sync_job_type') as queue_type,
              to_regtype('public.sync_job_status') as queue_status_type
          )
          select
            current_setting('transaction_read_only') = 'on' as transaction_read_only,
            app.is_service_role() as service_role_ready,
            coalesce((
              select relation.relkind = 'r'
                 and pg_get_userbyid(relation.relowner) = 'postgres'
                from pg_catalog.pg_class relation
               where relation.oid = to_regclass('public.sync_jobs')
            ), false) as queue_relation_ready,
            coalesce((
              select type_row.typtype = 'e'
                 and pg_get_userbyid(type_row.typowner) = 'postgres'
                 and array_agg(enum_row.enumlabel::text order by enum_row.enumsortorder) = array[
                   'entity.sync', 'report.request', 'report.poll', 'report.fetch',
                   'crosscheck.ingest', 'recommendations.run', 'keepa.sync', 'rank.sync',
                   'economics.sync', 'sqp.categorize', 'creative.sync', 'sqp.request',
                   'history.bootstrap', 'report.promote', 'marketing_stream.normalize',
                   'report.unified.advance'
                 ]::text[]
                from pg_catalog.pg_type type_row
                join pg_catalog.pg_enum enum_row on enum_row.enumtypid = type_row.oid
               where type_row.oid = queue_type
               group by type_row.typtype, type_row.typowner
            ), false) as queue_type_ready,
            coalesce((
              select type_row.typtype = 'e'
                 and pg_get_userbyid(type_row.typowner) = 'postgres'
                 and array_agg(enum_row.enumlabel::text order by enum_row.enumsortorder) = array[
                   'queued', 'running', 'succeeded', 'failed', 'dead'
                 ]::text[]
                from pg_catalog.pg_type type_row
                join pg_catalog.pg_enum enum_row on enum_row.enumtypid = type_row.oid
               where type_row.oid = queue_status_type
               group by type_row.typtype, type_row.typowner
            ), false) as queue_status_type_ready,
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
                 and i.indisready
                 and i.indislive
                 and i.indpred is not null
                 and i.indnkeyatts = 1
                 and i.indnatts = 1
                 and pg_get_userbyid(index_relation.relowner) = 'postgres'
                 and access_method.amname = 'btree'
                 and pg_get_indexdef(i.indexrelid, 1, true) = 'claim_token'
                 and pg_get_expr(i.indpred, i.indrelid) = '(claim_token IS NOT NULL)'
                from pg_catalog.pg_index i
                join pg_catalog.pg_class index_relation on index_relation.oid = i.indexrelid
                join pg_catalog.pg_am access_method
                  on access_method.oid = index_relation.relam
               where i.indexrelid = to_regclass('public.sync_jobs_claim_token_key')
                 and i.indrelid = 'public.sync_jobs'::regclass
            ), false) as claim_token_index_ready,
            not has_column_privilege('anon', 'public.sync_jobs', 'claim_token', 'SELECT')
              and not has_column_privilege(
                'authenticated', 'public.sync_jobs', 'claim_token', 'SELECT'
              ) as claim_token_acl_ready,
            coalesce((
              select authority.relkind = 'r'
                 and pg_get_userbyid(authority.relowner) = 'postgres'
                 and not authority.relrowsecurity
                 and (
                   select count(*) = 4
                     from pg_catalog.pg_attribute attribute
                    where attribute.attrelid = authority.oid
                      and attribute.attnum > 0
                      and not attribute.attisdropped
                 )
                 and exists (
                   select 1
                     from pg_catalog.pg_attribute attribute
                     join pg_catalog.pg_attrdef default_row
                       on default_row.adrelid = attribute.attrelid
                      and default_row.adnum = attribute.attnum
                    where attribute.attrelid = authority.oid
                      and attribute.attname = 'singleton'
                      and attribute.attnum = 1
                      and attribute.atttypid = 'boolean'::regtype
                      and attribute.attnotnull
                      and pg_get_expr(default_row.adbin, default_row.adrelid) = 'true'
                 )
                 and exists (
                   select 1
                     from pg_catalog.pg_attribute attribute
                     join pg_catalog.pg_attrdef default_row
                       on default_row.adrelid = attribute.attrelid
                      and default_row.adnum = attribute.attnum
                    where attribute.attrelid = authority.oid
                      and attribute.attname = 'protocol'
                      and attribute.attnum = 2
                      and attribute.atttypid = 'text'::regtype
                      and attribute.attnotnull
                      and pg_get_expr(default_row.adbin, default_row.adrelid) = '''legacy''::text'
                 )
                 and exists (
                   select 1
                     from pg_catalog.pg_attribute attribute
                     join pg_catalog.pg_attrdef default_row
                       on default_row.adrelid = attribute.attrelid
                      and default_row.adnum = attribute.attnum
                    where attribute.attrelid = authority.oid
                      and attribute.attname = 'epoch'
                      and attribute.attnum = 3
                      and attribute.atttypid = 'bigint'::regtype
                      and attribute.attnotnull
                      and pg_get_expr(default_row.adbin, default_row.adrelid) = '0'
                 )
                 and exists (
                   select 1
                     from pg_catalog.pg_attribute attribute
                     join pg_catalog.pg_attrdef default_row
                       on default_row.adrelid = attribute.attrelid
                      and default_row.adnum = attribute.attnum
                    where attribute.attrelid = authority.oid
                      and attribute.attname = 'updated_at'
                      and attribute.attnum = 4
                      and attribute.atttypid = 'timestamp with time zone'::regtype
                      and attribute.attnotnull
                      and pg_get_expr(default_row.adbin, default_row.adrelid) = 'now()'
                 )
                 and not exists (
                   select 1
                     from aclexplode(coalesce(
                       authority.relacl,
                       acldefault('r', authority.relowner)
                     )) acl
                    where acl.grantee <> authority.relowner
                 )
                 and not has_table_privilege(
                   'service_role', authority.oid,
                   'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
                 )
                from pg_catalog.pg_class authority
               where authority.oid = to_regclass('app.report_worker_claim_authority')
            ), false) as authority_relation_ready,
            coalesce((
              select jsonb_agg(
                       jsonb_build_object(
                         'name', constraint_row.conname,
                         'type', constraint_row.contype,
                         'columnNumbers', constraint_row.conkey,
                         'columnNames', (
                           select array_agg(attribute.attname::text order by constrained.ordinality)
                             from unnest(constraint_row.conkey) with ordinality
                               constrained(attnum, ordinality)
                             join pg_catalog.pg_attribute attribute
                               on attribute.attrelid = constraint_row.conrelid
                              and attribute.attnum = constrained.attnum
                         ),
                         'definition', pg_get_constraintdef(constraint_row.oid, true)
                       )
                       order by constraint_row.conname
                     )
                from pg_catalog.pg_constraint constraint_row
               where constraint_row.conrelid = to_regclass(
                 'app.report_worker_claim_authority'
               )
            ), '[]'::jsonb) as authority_constraints,
            has_table_privilege(current_user, 'public.sync_jobs', 'SELECT') as queue_read_ready,
            coalesce(
              has_type_privilege(current_user, queue_type, 'USAGE'), false
            ) as queue_type_access_ready
          from queue_contract
        `;
        const functionRows = await queryFunctionCatalog(sql);
        await sql`select id, claim_token from public.sync_jobs limit 0`;
        return [contract, functionRows];
      }),
      timeoutMs,
    );
    if (!READY_FIELDS.every((field) => result?.[field] === true)) {
      throw new Error(SANITIZED_FAILURE);
    }
    verifyAuthorityConstraintCatalog(result.authority_constraints);
    verifyFunctionCatalog(functions, functionContracts);
  });
}

export function verifyAuthorityConstraintCatalog(rows) {
  if (
    !Array.isArray(rows)
    || rows.length !== REPORT_WORKER_AUTHORITY_CONSTRAINTS.length
  ) {
    throw new Error(SANITIZED_FAILURE);
  }
  const expectedKeys = ['columnNames', 'columnNumbers', 'definition', 'name', 'type'];
  for (let index = 0; index < REPORT_WORKER_AUTHORITY_CONSTRAINTS.length; index += 1) {
    const row = rows[index];
    const contract = REPORT_WORKER_AUTHORITY_CONSTRAINTS[index];
    if (
      !row
      || typeof row !== 'object'
      || Array.isArray(row)
      || JSON.stringify(Object.keys(row).sort()) !== JSON.stringify(expectedKeys)
      || row.name !== contract.name
      || row.type !== contract.type
      || row.definition !== contract.definition
      || JSON.stringify(row.columnNumbers) !== JSON.stringify(contract.columnNumbers)
      || JSON.stringify(row.columnNames) !== JSON.stringify(contract.columnNames)
    ) {
      throw new Error(SANITIZED_FAILURE);
    }
  }
}

async function queryFunctionCatalog(sql) {
  return sql`
    with required_functions(function_key, function_oid) as (
      values
        ('legacy_claim_unfiltered', to_regprocedure('public.claim_sync_jobs(text,integer)')),
        ('legacy_claim_filtered', to_regprocedure(
          'public.claim_sync_jobs(text,integer,public.sync_job_type[])'
        )),
        ('legacy_finish', to_regprocedure(
          'public.finish_sync_job(uuid,public.sync_job_status,text,jsonb,interval)'
        )),
        ('legacy_reaper', to_regprocedure('public.requeue_stale_sync_jobs(interval)')),
        ('fenced_claim', to_regprocedure(
          'public.claim_sync_jobs_fenced(text,integer,public.sync_job_type[])'
        )),
        ('fenced_finish', to_regprocedure(
          'public.finish_sync_job_fenced(uuid,uuid,public.sync_job_status,text,jsonb,interval)'
        )),
        ('fenced_defer', to_regprocedure(
          'public.defer_sync_job_fenced(uuid,uuid,interval)'
        )),
        ('authority_get', to_regprocedure('public.get_report_worker_claim_authority()')),
        ('authority_activate', to_regprocedure(
          'public.activate_report_worker_fenced_claims()'
        ))
    )
    select
      required.function_key,
      pg_get_userbyid(function_row.proowner) as owner_name,
      language.lanname as language_name,
      function_row.provolatile as volatility,
      function_row.proleakproof as leakproof,
      function_row.prosecdef as security_definer,
      function_row.proconfig as configuration,
      function_row.prosrc as source,
      case required.function_key
        when 'legacy_claim_unfiltered' then
          function_row.proretset
          and function_row.prorettype = 'public.sync_jobs'::regtype
          and function_row.pronargs = 2
          and function_row.pronargdefaults = 0
          and function_row.proallargtypes is null
          and function_row.proargmodes is null
          and function_row.proargnames = array['p_worker_id','p_limit']
        when 'legacy_claim_filtered' then
          function_row.proretset
          and function_row.prorettype = 'public.sync_jobs'::regtype
          and function_row.pronargs = 3
          and function_row.pronargdefaults = 0
          and function_row.proallargtypes is null
          and function_row.proargmodes is null
          and function_row.proargnames = array['p_worker_id','p_limit','p_job_types']
        when 'legacy_finish' then
          not function_row.proretset
          and function_row.prorettype = 'public.sync_jobs'::regtype
          and function_row.pronargs = 5
          and function_row.pronargdefaults = 3
          and function_row.proallargtypes is null
          and function_row.proargmodes is null
          and function_row.proargnames = array[
            'p_job_id','p_status','p_error','p_result','p_retry_in'
          ]
        when 'legacy_reaper' then
          not function_row.proretset
          and function_row.prorettype = 'integer'::regtype
          and function_row.pronargs = 1
          and function_row.pronargdefaults = 1
          and function_row.proallargtypes is null
          and function_row.proargmodes is null
          and function_row.proargnames = array['p_older_than']
        when 'fenced_claim' then
          function_row.proretset
          and function_row.prorettype = 'public.sync_jobs'::regtype
          and function_row.pronargs = 3
          and function_row.pronargdefaults = 0
          and function_row.proallargtypes is null
          and function_row.proargmodes is null
          and function_row.proargnames = array['p_worker_id','p_limit','p_job_types']
        when 'fenced_finish' then
          function_row.proretset
          and function_row.prorettype = 'record'::regtype
          and function_row.pronargs = 6
          and function_row.pronargdefaults = 3
          and function_row.proallargtypes = array[
            'uuid'::regtype, 'uuid'::regtype, 'public.sync_job_status'::regtype,
            'text'::regtype, 'jsonb'::regtype, 'interval'::regtype,
            'text'::regtype, 'public.sync_job_status'::regtype, 'integer'::regtype
          ]::oid[]
          and function_row.proargmodes = array[
            'i','i','i','i','i','i','t','t','t'
          ]::"char"[]
          and function_row.proargnames = array[
            'p_job_id','p_claim_token','p_status','p_error','p_result','p_retry_in',
            'decision','status','attempts'
          ]
        when 'fenced_defer' then
          function_row.proretset
          and function_row.prorettype = 'record'::regtype
          and function_row.pronargs = 3
          and function_row.pronargdefaults = 0
          and function_row.proallargtypes = array[
            'uuid'::regtype, 'uuid'::regtype, 'interval'::regtype,
            'text'::regtype, 'public.sync_job_status'::regtype, 'integer'::regtype
          ]::oid[]
          and function_row.proargmodes = array['i','i','i','t','t','t']::"char"[]
          and function_row.proargnames = array[
            'p_job_id','p_claim_token','p_retry_in','decision','status','attempts'
          ]
        when 'authority_get' then
          function_row.proretset
          and function_row.prorettype = 'record'::regtype
          and function_row.pronargs = 0
          and function_row.pronargdefaults = 0
          and function_row.proallargtypes = array['text'::regtype, 'bigint'::regtype]::oid[]
          and function_row.proargmodes = array['t','t']::"char"[]
          and function_row.proargnames = array['protocol','epoch']
        when 'authority_activate' then
          function_row.proretset
          and function_row.prorettype = 'record'::regtype
          and function_row.pronargs = 0
          and function_row.pronargdefaults = 0
          and function_row.proallargtypes = array[
            'text'::regtype, 'bigint'::regtype, 'integer'::regtype
          ]::oid[]
          and function_row.proargmodes = array['t','t','t']::"char"[]
          and function_row.proargnames = array['decision','epoch','unresolved']
        else false
      end as signature_ready,
      coalesce((
        select array_agg(
                 (case when acl.grantee = 0 then 'PUBLIC'
                       else pg_get_userbyid(acl.grantee) end)::text
                 order by case when acl.grantee = 0 then 'PUBLIC'
                               else pg_get_userbyid(acl.grantee) end
               ) = array['postgres','service_role']::text[]
           and bool_and(acl.privilege_type = 'EXECUTE')
           and not bool_or(acl.is_grantable)
          from aclexplode(coalesce(
            function_row.proacl,
            acldefault('f', function_row.proowner)
          )) acl
      ), false) as acl_ready
    from required_functions required
    left join pg_catalog.pg_proc function_row on function_row.oid = required.function_oid
    left join pg_catalog.pg_language language on language.oid = function_row.prolang
    order by required.function_key
  `;
}

export function verifyFunctionCatalog(rows, contracts = REPORT_WORKER_FUNCTION_CONTRACTS) {
  validateFunctionContracts(contracts);
  if (!Array.isArray(rows) || rows.length !== contracts.length) {
    throw new Error(SANITIZED_FAILURE);
  }
  const rowsByKey = new Map(rows.map((row) => [row?.function_key, row]));
  if (rowsByKey.size !== contracts.length) throw new Error(SANITIZED_FAILURE);
  const expectedKeys = [
    'acl_ready', 'configuration', 'function_key', 'language_name', 'leakproof',
    'owner_name', 'security_definer', 'signature_ready', 'source', 'volatility',
  ];
  for (const contract of contracts) {
    const row = rowsByKey.get(contract.key);
    if (
      !row
      || JSON.stringify(Object.keys(row).sort()) !== JSON.stringify(expectedKeys)
      || row.owner_name !== 'postgres'
      || row.language_name !== 'plpgsql'
      || row.volatility !== contract.volatility
      || row.leakproof !== false
      || row.security_definer !== true
      || JSON.stringify(row.configuration) !== JSON.stringify([
        'search_path=pg_catalog, public, pg_temp',
      ])
      || row.signature_ready !== true
      || row.acl_ready !== true
      || typeof row.source !== 'string'
      || row.source.length > 100_000
      || createHash('sha256').update(row.source).digest('hex') !== contract.sourceHash
    ) {
      throw new Error(SANITIZED_FAILURE);
    }
  }
}

function validateFunctionContracts(contracts) {
  if (
    !Array.isArray(contracts)
    || contracts.length !== 9
    || new Set(contracts.map((contract) => contract?.key)).size !== 9
    || contracts.some((contract) => (
      typeof contract?.key !== 'string'
      || !['v', 's'].includes(contract.volatility)
      || !/^[0-9a-f]{64}$/u.test(contract.sourceHash)
    ))
  ) {
    throw new Error(SANITIZED_FAILURE);
  }
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

/** Prove fenced authority and drained custody from one read-only database snapshot. */
export async function verifyReportWorkerStartupGate({
  databaseUrl,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  createHandle,
}) {
  validateInputs(databaseUrl, timeoutMs, createHandle, AUTHORITY_FAILURE);

  return withHandle(databaseUrl, timeoutMs, createHandle, AUTHORITY_FAILURE, async (handle) => {
    const rows = await withDeadline(
      handle.sql.begin('read only', async (sql) => sql`
        select
          authority.protocol,
          authority.epoch,
          custody.unresolved
        from public.get_report_worker_claim_authority() authority
        cross join lateral (
          select count(*)::integer as unresolved
            from public.sync_jobs job
           where job.job_type = any(array[
             'creative.sync', 'report.request', 'report.poll', 'report.fetch'
           ]::public.sync_job_type[])
             and (job.status = 'running' or job.claim_token is not null)
        ) custody
      `),
      timeoutMs,
    );
    const state = parseAuthorityResult(rows, ['epoch', 'protocol', 'unresolved'], AUTHORITY_FAILURE);
    if (state.protocol !== 'fenced' || state.unresolved !== 0 || !positiveEpoch(state.epoch)) {
      throw new Error(AUTHORITY_FAILURE);
    }
    return Object.freeze(state);
  });
}

/** Prove only the one-way authority state; live verification must not require a drained lane. */
export async function verifyReportWorkerFencedAuthority({
  databaseUrl,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  createHandle,
}) {
  validateInputs(databaseUrl, timeoutMs, createHandle, AUTHORITY_FAILURE);

  return withHandle(databaseUrl, timeoutMs, createHandle, AUTHORITY_FAILURE, async (handle) => {
    const rows = await withDeadline(
      handle.sql.begin('read only', async (sql) => sql`
        select protocol, epoch
          from public.get_report_worker_claim_authority()
      `),
      timeoutMs,
    );
    const state = parseAuthorityResult(rows, ['epoch', 'protocol'], AUTHORITY_FAILURE);
    if (state.protocol !== 'fenced' || !positiveEpoch(state.epoch)) {
      throw new Error(AUTHORITY_FAILURE);
    }
    return Object.freeze(state);
  });
}

/** Invoke the database-owned one-way cutover barrier and return only its sanitized decision. */
export async function activateReportWorkerFencedAuthority({
  databaseUrl,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  createHandle,
}) {
  validateInputs(databaseUrl, timeoutMs, createHandle, ACTIVATION_FAILURE);

  return withHandle(databaseUrl, timeoutMs, createHandle, ACTIVATION_FAILURE, async (handle) => {
    const rows = await withDeadline(
      handle.sql`
        select decision, epoch, unresolved
          from public.activate_report_worker_fenced_claims()
      `,
      timeoutMs,
    );
    const state = parseAuthorityResult(
      rows,
      ['decision', 'epoch', 'unresolved'],
      ACTIVATION_FAILURE,
    );
    if (
      !['activated', 'already_fenced', 'unresolved'].includes(state.decision)
      || (state.decision === 'activated' && (state.unresolved !== 0 || !positiveEpoch(state.epoch)))
      || (state.decision === 'already_fenced' && !positiveEpoch(state.epoch))
      || (state.decision === 'unresolved' && state.unresolved < 1)
    ) {
      throw new Error(ACTIVATION_FAILURE);
    }
    return Object.freeze(state);
  });
}

function parseAuthorityResult(rows, expectedKeys, failure) {
  if (!Array.isArray(rows) || rows.length !== 1) throw new Error(failure);
  const row = rows[0];
  if (
    !row
    || typeof row !== 'object'
    || Array.isArray(row)
    || JSON.stringify(Object.keys(row).sort()) !== JSON.stringify(expectedKeys)
  ) {
    throw new Error(failure);
  }
  const epoch = normalizeEpoch(row.epoch, failure);
  const parsed = { ...row, epoch };
  if ('protocol' in parsed && !['legacy', 'fenced'].includes(parsed.protocol)) {
    throw new Error(failure);
  }
  if ('decision' in parsed && typeof parsed.decision !== 'string') throw new Error(failure);
  if (
    'unresolved' in parsed
    && (!Number.isInteger(parsed.unresolved) || parsed.unresolved < 0)
  ) {
    throw new Error(failure);
  }
  return parsed;
}

function normalizeEpoch(value, failure) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return String(value);
  }
  if (typeof value === 'bigint' && value >= 0n) return String(value);
  if (typeof value === 'string' && /^(?:0|[1-9][0-9]*)$/u.test(value)) return value;
  throw new Error(failure);
}

function positiveEpoch(value) {
  return /^(?:[1-9][0-9]*)$/u.test(value);
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
  if (mode === '--startup-gate') {
    await verifyReportWorkerStartupGate({ databaseUrl, createHandle });
    return;
  }
  if (mode === '--fenced-authority') {
    await verifyReportWorkerFencedAuthority({ databaseUrl, createHandle });
    return;
  }
  if (mode === '--activate-fenced-authority') {
    const result = await activateReportWorkerFencedAuthority({ databaseUrl, createHandle });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  throw new Error(SANITIZED_FAILURE);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCommand().catch((error) => {
    const message = [CUSTODY_FAILURE, AUTHORITY_FAILURE, ACTIVATION_FAILURE].includes(error?.message)
      ? error.message
      : SANITIZED_FAILURE;
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
