import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import {
  applySqlFile,
  createTestDatabase,
  databaseAvailable,
} from './testing/harness.js';
import type { TestDatabase } from './testing/harness.js';
import { asServiceRole } from './testing/rls.js';

const BEFORE = '20260901020000_sp_write_persistence_ledger.sql';
const MIGRATION_NAME = [
  '20260901030000',
  'sp',
  'write',
  'outbox',
  'delivery',
].join('_') + '.sql';
const MIGRATION = fileURLToPath(
  new URL(
    ['..', '..', '..', 'supabase', 'migrations', MIGRATION_NAME].join('/'),
    import.meta.url,
  ),
);
const DDL_LOCK_KEY = 'wizard-ads:schema-ddl:v1';
const available = await databaseAvailable();
const migrationSource = await readFile(MIGRATION, 'utf8');

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

interface DispatchWakeFixture {
  orgId: string;
  profileId: string;
  executionId: string;
  planId: string;
  approvalId: string;
  generation: string;
  outboxId: string;
}

interface DispatchClaim {
  offered_count: number;
  claimed_count: number;
  claim_ordinal: number | null;
  outbox_id: string | null;
  claim_epoch: string | null;
  claim_token: string | null;
  claimed_at: Date | null;
  lease_expires_at: Date | null;
}

type CustodyConsumer = 'renew' | 'defer' | 'complete' | 'acquire' | 'reserve';

interface CustodySnapshot {
  outboxes: number;
  heads: number;
  events: number;
  leases: number;
  dispositions: number;
  resolutions: number;
  intents: number;
}

async function seedDispatchCycle(
  database: TestDatabase,
  options: { createOutbox?: boolean; createDeliveryHead?: boolean; createRequest?: boolean } = {},
): Promise<DispatchWakeFixture> {
  const orgId = randomUUID();
  const connectionId = randomUUID();
  const profileId = randomUUID();
  const executionId = randomUUID();
  const planId = randomUUID();
  const approvalId = randomUUID();
  const generation = randomUUID();
  const outboxId = randomUUID();
  const fingerprint = sha256(planId);
  const createOutbox = options.createOutbox ?? true;
  const createDeliveryHead = options.createDeliveryHead ?? createOutbox;

  await database.sql`
    insert into public.orgs (id, slug, name)
    values (${orgId}::uuid, ${`wp192-${orgId.slice(0, 8)}`}, 'WP 192 synthetic tenant')
  `;
  await database.sql`
    insert into public.ads_connections (id, org_id, label, status)
    values (${connectionId}::uuid, ${orgId}::uuid, 'synthetic-delivery', 'active')
  `;
  await database.sql`
    insert into public.ad_profiles (
      id, org_id, connection_id, amazon_profile_id, region, country_code,
      currency_code, timezone, sync_enabled, first_seen_at
    ) values (
      ${profileId}::uuid, ${orgId}::uuid, ${connectionId}::uuid,
      ${`synthetic-${profileId.slice(0, 8)}`}, 'NA', 'US', 'USD', 'UTC', false,
      clock_timestamp()
    )
  `;

  await database.sql.begin(async (transaction) => {
    await transaction.unsafe("set local session_replication_role = 'replica'");
    await transaction`
      insert into public.sp_write_plans (
        plan_id, org_id, profile_id, direction, artifact_text, artifact,
        fingerprint_preimage, fingerprint, amazon_profile_id, connection_id,
        region, marketplace_id, currency_code, api_dialect, source_execution_id,
        source_plan_id, source_plan_fingerprint, generated_at, frozen_at,
        expires_at, logical_changes, provider_rows, unique_entities
      ) values (
        ${planId}::uuid, ${orgId}::uuid, ${profileId}::uuid, 'forward', '{}', '{}'::jsonb,
        ${`fixture:${planId}`}, ${fingerprint}, ${`synthetic-${profileId.slice(0, 8)}`},
        ${connectionId}::uuid, 'NA', 'synthetic-marketplace', 'USD', 'sp_v3',
        null, null, null, clock_timestamp() - interval '2 minutes',
        clock_timestamp() - interval '1 minute', clock_timestamp() + interval '1 day',
        1, 1, 1
      )
    `;
    await transaction`
      insert into public.sp_write_cycle_plans (
        org_id, profile_id, execution_id, plan_id, receipt_plan_id,
        approval_id, generation, direction
      ) values (
        ${orgId}::uuid, ${profileId}::uuid, ${executionId}::uuid,
        ${planId}::uuid, ${planId}::uuid, ${approvalId}::uuid,
        ${generation}::uuid, 'forward'
      )
    `;
    if (options.createRequest) {
      await transaction`
        insert into public.sp_write_execution_requests (
          org_id, profile_id, execution_id, plan_id, approval_id, generation
        ) values (
          ${orgId}::uuid, ${profileId}::uuid, ${executionId}::uuid,
          ${planId}::uuid, ${approvalId}::uuid, ${generation}::uuid
        )
      `;
    }
    if (createOutbox) {
      await transaction`
        insert into public.sp_write_outbox (
          outbox_id, org_id, profile_id, execution_id, plan_id, approval_id,
          generation, kind, provider_call_id, intent_id, source_sync_job_id,
          created_at
        ) values (
          ${outboxId}::uuid, ${orgId}::uuid, ${profileId}::uuid,
          ${executionId}::uuid, ${planId}::uuid, ${approvalId}::uuid,
          ${generation}::uuid, 'dispatch', null, null, null, clock_timestamp()
        )
      `;
      if (createDeliveryHead) {
        await transaction`
          insert into app.sp_write_outbox_delivery_heads (
            org_id, profile_id, outbox_id, state, claim_epoch,
            transition_sequence, available_at, attempt_count
          ) values (
            ${orgId}::uuid, ${profileId}::uuid, ${outboxId}::uuid,
            'available', 0, 0, clock_timestamp(), 0
          )
        `;
      }
    }
  });

  return { orgId, profileId, executionId, planId, approvalId, generation, outboxId };
}

async function insertDispatchOutboxWithTrigger(
  database: TestDatabase,
  fixture: DispatchWakeFixture,
): Promise<void> {
  await database.sql`
    insert into public.sp_write_outbox (
      outbox_id, org_id, profile_id, execution_id, plan_id, approval_id,
      generation, kind, provider_call_id, intent_id, source_sync_job_id
    ) values (
      ${fixture.outboxId}::uuid, ${fixture.orgId}::uuid, ${fixture.profileId}::uuid,
      ${fixture.executionId}::uuid, ${fixture.planId}::uuid, ${fixture.approvalId}::uuid,
      ${fixture.generation}::uuid, 'dispatch', null, null, null
    )
  `;
}

async function claimOne(
  database: TestDatabase,
  claimantId: string,
): Promise<DispatchClaim> {
  const [row] = await database.sql<DispatchClaim[]>`
    select offered_count, claimed_count, claim_ordinal, outbox_id::text,
           claim_epoch::text, claim_token::text, claimed_at, lease_expires_at
    from app.claim_sp_write_outbox(
      ${claimantId}, array['dispatch']::public.sp_write_outbox_kind[], 1, 70
    )
  `;
  if (row === undefined) throw new Error('claim returned no header row');
  return row;
}

async function waitForDatabaseLock(
  database: TestDatabase,
  queryFragment: string,
  timeoutMs = 4_000,
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const [row] = await database.sql<{ waiting: boolean }[]>`
      select exists (
        select 1
        from pg_catalog.pg_stat_activity activity
        where activity.datname = current_database()
          and activity.pid <> pg_backend_pid()
          and activity.wait_event_type = 'Lock'
          and activity.query like ${`%${queryFragment}%`}
      ) as waiting
    `;
    if (row?.waiting) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`database call did not enter a Lock wait: ${queryFragment}`);
}

async function custodySnapshot(
  database: TestDatabase,
  fixture: DispatchWakeFixture,
): Promise<CustodySnapshot> {
  const [row] = await database.sql<CustodySnapshot[]>`
    select
      (select count(*)::int from public.sp_write_outbox
        where outbox_id = ${fixture.outboxId}::uuid) as outboxes,
      (select count(*)::int from app.sp_write_outbox_delivery_heads
        where outbox_id = ${fixture.outboxId}::uuid) as heads,
      (select count(*)::int from app.sp_write_outbox_delivery_events
        where outbox_id = ${fixture.outboxId}::uuid) as events,
      (select count(*)::int from public.sp_write_dispatch_leases
        where execution_id = ${fixture.executionId}::uuid) as leases,
      (select count(*)::int from public.sp_write_predispatch_dispositions
        where execution_id = ${fixture.executionId}::uuid) as dispositions,
      (select count(*)::int from public.sp_write_action_resolutions
        where execution_id = ${fixture.executionId}::uuid) as resolutions,
      (select count(*)::int from public.sp_write_provider_call_intents
        where execution_id = ${fixture.executionId}::uuid) as intents
  `;
  if (row === undefined) throw new Error('custody snapshot returned no row');
  return row;
}

async function invokeCustodyConsumer(
  database: TestDatabase,
  fixture: DispatchWakeFixture,
  claim: DispatchClaim,
  consumer: CustodyConsumer,
): Promise<{ decision?: string; reason?: string | null; availableAt?: Date | null; code?: string }> {
  if (claim.claim_epoch === null || claim.claim_token === null) {
    throw new Error('custody consumer fixture is missing a claim credential');
  }
  try {
    if (consumer === 'renew') {
      const [row] = await database.sql<{ decision: string }[]>`
        select decision from app.renew_sp_write_outbox_claim(
          ${fixture.outboxId}::uuid, ${claim.claim_epoch}::bigint,
          ${claim.claim_token}::uuid, 120
        )
      `;
      return { decision: row?.decision };
    }
    if (consumer === 'defer') {
      const [row] = await database.sql<{
        decision: string;
        reason: string | null;
        available_at: Date | null;
      }[]>`
        select decision, reason, available_at
        from app.defer_sp_write_outbox_claim(
          ${fixture.outboxId}::uuid, ${claim.claim_epoch}::bigint,
          ${claim.claim_token}::uuid, 'shutdown'
        )
      `;
      return {
        decision: row?.decision,
        reason: row?.reason,
        availableAt: row?.available_at,
      };
    }
    if (consumer === 'complete') {
      const [row] = await database.sql<{ decision: string }[]>`
        select decision from app.complete_sp_write_outbox_claim(
          ${fixture.outboxId}::uuid, ${claim.claim_epoch}::bigint,
          ${claim.claim_token}::uuid
        )
      `;
      return { decision: row?.decision };
    }
    if (consumer === 'acquire') {
      await database.sql`
        select * from app.acquire_sp_write_dispatch_lease_for_claim(
          ${fixture.outboxId}::uuid, ${claim.claim_epoch}::bigint,
          ${claim.claim_token}::uuid, 'sp.v3.keywords.update', 70
        )
      `;
      return { decision: 'acquired' };
    }
    const [row] = await database.sql<{ decision: string }[]>`
      select decision from app.reserve_sp_write_provider_call_for_claim(
        ${fixture.outboxId}::uuid, ${claim.claim_epoch}::bigint,
        ${claim.claim_token}::uuid, ${fixture.executionId}::uuid,
        ${fixture.planId}::uuid, ${fixture.generation}::uuid,
        ${randomUUID()}::uuid, 'unreached', 'unreached', 'unreached',
        'unreached', 'unreached'
      )
    `;
    return { decision: row?.decision };
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error
      && typeof error.code === 'string'
      ? error.code
      : undefined;
    return { code };
  }
}

describe.skipIf(!available)('SP write outbox delivery migration safety', () => {
  it('replays the full migration ledger into an empty, inert delivery surface', async () => {
    const database = await createTestDatabase('sp_write_outbox_fresh', { applyFixture: false });
    try {
      const [counts] = await database.sql<{
        outboxes: number;
        heads: number;
        events: number;
      }[]>`
        select
          (select count(*)::int from public.sp_write_outbox) as outboxes,
          (select count(*)::int from app.sp_write_outbox_delivery_heads) as heads,
          (select count(*)::int from app.sp_write_outbox_delivery_events) as events
      `;
      expect(counts).toEqual({ outboxes: 0, heads: 0, events: 0 });
    } finally {
      await database.drop();
    }
  }, 60_000);

  it('uses the exact bounded migration envelope and no top-level DO block', () => {
    expect(migrationSource.startsWith(
      "-- WP-192: private, token-fenced delivery custody for the immutable SP write outbox.",
    )).toBe(true);
    expect(migrationSource).toContain("set local lock_timeout = '5s';\nselect pg_advisory_xact_lock(");
    expect(migrationSource.match(/\block_timeout\b/gu)).toHaveLength(1);
    expect(migrationSource).not.toMatch(/^\s*do\b/gimu);
  });

  it('fails closed under the shared DDL lock, then applies cleanly', async () => {
    const database = await createTestDatabase('sp_write_outbox_ddl_lock', {
      throughMigration: BEFORE,
      applyFixture: false,
    });
    try {
      const acquired = deferred();
      const release = deferred();
      const holder = database.sql.begin(async (transaction) => {
        await transaction`
          select pg_advisory_xact_lock(pg_catalog.hashtextextended(${DDL_LOCK_KEY}, 0))
        `;
        acquired.resolve();
        await release.promise;
      });
      await acquired.promise;
      const startedAt = performance.now();
      let failure: unknown;
      try {
        await applySqlFile(database, MIGRATION);
      } catch (error) {
        failure = error;
      } finally {
        release.resolve();
        await holder;
      }
      const elapsed = performance.now() - startedAt;
      expect(failure).toMatchObject({ code: '55P03' });
      expect(elapsed).toBeGreaterThanOrEqual(4_500);
      expect(elapsed).toBeLessThan(8_000);
      const [partial] = await database.sql<{ relation_count: number }[]>`
        select count(*)::int as relation_count
        from pg_catalog.pg_class class
        join pg_catalog.pg_namespace namespace on namespace.oid = class.relnamespace
        where namespace.nspname = 'app'
          and class.relname like 'sp_write_outbox_delivery_%'
      `;
      expect(partial?.relation_count).toBe(0);
      await applySqlFile(database, MIGRATION);
    } finally {
      await database.drop();
    }
  }, 60_000);

  it('exposes only the six service capabilities and closes direct DML', async () => {
    const database = await createTestDatabase('sp_write_outbox_acl', { applyFixture: false });
    try {
      const functions = await database.sql<{
        name: string;
        service_execute: boolean;
        anonymous_execute: boolean;
        authenticated_execute: boolean;
      }[]>`
        select function.proname as name,
               has_function_privilege('service_role', function.oid, 'EXECUTE') as service_execute,
               has_function_privilege('anon', function.oid, 'EXECUTE') as anonymous_execute,
               has_function_privilege('authenticated', function.oid, 'EXECUTE') as authenticated_execute
        from pg_catalog.pg_proc function
        join pg_catalog.pg_namespace namespace on namespace.oid = function.pronamespace
        where namespace.nspname = 'app'
          and function.proname in (
            'claim_sp_write_outbox',
            'renew_sp_write_outbox_claim',
            'defer_sp_write_outbox_claim',
            'complete_sp_write_outbox_claim',
            'acquire_sp_write_dispatch_lease_for_claim',
            'reserve_sp_write_provider_call_for_claim'
          )
        order by function.proname
      `;
      expect(functions).toHaveLength(6);
      expect(functions.every((row) => row.service_execute)).toBe(true);
      expect(functions.every((row) => !row.anonymous_execute && !row.authenticated_execute)).toBe(true);

      const [oldAuthority] = await database.sql<{
        old_lease: boolean;
        old_reservation: boolean;
        head_select: boolean;
        head_update: boolean;
        event_insert: boolean;
      }[]>`
        select
          has_function_privilege(
            'service_role',
            'app.acquire_sp_write_dispatch_lease(uuid,uuid,uuid,public.sp_write_route_key,integer)',
            'EXECUTE'
          ) as old_lease,
          has_function_privilege(
            'service_role',
            'app.reserve_sp_write_provider_call(uuid,uuid,uuid,uuid,text,text,text,text,text)',
            'EXECUTE'
          ) as old_reservation,
          has_table_privilege('service_role', 'app.sp_write_outbox_delivery_heads', 'SELECT') as head_select,
          has_table_privilege('service_role', 'app.sp_write_outbox_delivery_heads', 'UPDATE') as head_update,
          has_table_privilege('service_role', 'app.sp_write_outbox_delivery_events', 'INSERT') as event_insert
      `;
      expect(oldAuthority).toEqual({
        old_lease: false,
        old_reservation: false,
        head_select: false,
        head_update: false,
        event_insert: false,
      });

      const internals = await database.sql<{ name: string; service_execute: boolean }[]>`
        select function.proname as name,
               has_function_privilege('service_role', function.oid, 'EXECUTE') as service_execute
        from pg_catalog.pg_proc function
        join pg_catalog.pg_namespace namespace on namespace.oid = function.pronamespace
        where namespace.nspname = 'app'
          and function.proname in (
            'sp_write_outbox_claim_token_digest',
            'sp_write_create_outbox_delivery_head',
            'sp_write_outbox_domain_complete',
            'sp_write_outbox_domain_claimable',
            'reject_sp_write_delivery_head_delete'
          )
        order by function.proname
      `;
      expect(internals).toHaveLength(5);
      expect(internals.every((row) => !row.service_execute)).toBe(true);
      await expect(asServiceRole(database, async (sql) => {
        await sql`update app.sp_write_outbox_delivery_heads set state = state`;
      })).rejects.toMatchObject({ code: '42501' });
      await expect(asServiceRole(database, async (sql) => {
        await sql`truncate app.sp_write_outbox_delivery_events`;
      })).rejects.toMatchObject({ code: '42501' });
    } finally {
      await database.drop();
    }
  }, 60_000);

  it('backfills existing wakes exactly and attaches genesis to later inserts', async () => {
    const database = await createTestDatabase('sp_write_outbox_upgrade', {
      throughMigration: BEFORE,
      applyFixture: false,
    });
    try {
      const legacy = await seedDispatchCycle(database, { createDeliveryHead: false });
      const [before] = await database.sql<{
        outbox_id: string;
        created_at: Date;
        row_text: string;
      }[]>`
        select outbox_id::text, created_at, row_to_json(source)::text as row_text
        from public.sp_write_outbox source
        where outbox_id = ${legacy.outboxId}::uuid
      `;
      await applySqlFile(database, MIGRATION);
      const [after] = await database.sql<{
        outbox_id: string;
        created_at: Date;
        row_text: string;
        available_at: Date;
        claim_epoch: string;
        transition_sequence: string;
        attempt_count: string;
        events: number;
      }[]>`
        select source.outbox_id::text, source.created_at,
               row_to_json(source)::text as row_text, head.available_at,
               head.claim_epoch::text, head.transition_sequence::text,
               head.attempt_count::text,
               (select count(*)::int from app.sp_write_outbox_delivery_events) as events
        from public.sp_write_outbox source
        join app.sp_write_outbox_delivery_heads head
          on head.org_id = source.org_id
         and head.profile_id = source.profile_id
         and head.outbox_id = source.outbox_id
        where source.outbox_id = ${legacy.outboxId}::uuid
      `;
      expect(after?.row_text).toBe(before?.row_text);
      expect(new Date(String(after?.available_at)).toISOString()).toBe(
        new Date(String(before?.created_at)).toISOString(),
      );
      expect(after).toMatchObject({
        claim_epoch: '0',
        transition_sequence: '0',
        attempt_count: '0',
        events: 0,
      });

      const later = await seedDispatchCycle(database, { createOutbox: false });
      await insertDispatchOutboxWithTrigger(database, later);
      const [triggered] = await database.sql<{ heads: number; events: number }[]>`
        select
          (select count(*)::int from app.sp_write_outbox_delivery_heads
            where outbox_id = ${later.outboxId}::uuid) as heads,
          (select count(*)::int from app.sp_write_outbox_delivery_events
            where outbox_id = ${later.outboxId}::uuid) as events
      `;
      expect(triggered).toEqual({ heads: 1, events: 0 });
    } finally {
      await database.drop();
    }
  }, 60_000);

  it('binds each private row through the exact composite parent and fixes function security', async () => {
    const database = await createTestDatabase('sp_write_outbox_catalog', { applyFixture: false });
    try {
      const foreignKeys = await database.sql<{
        name: string;
        child: string;
        parent: string;
        definition: string;
      }[]>`
        select constraint_row.conname as name,
               child.relname as child,
               parent.relname as parent,
               pg_catalog.pg_get_constraintdef(constraint_row.oid) as definition
        from pg_catalog.pg_constraint constraint_row
        join pg_catalog.pg_class child on child.oid = constraint_row.conrelid
        join pg_catalog.pg_class parent on parent.oid = constraint_row.confrelid
        where constraint_row.conname in (
          'sp_write_outbox_delivery_heads_outbox_fkey',
          'sp_write_outbox_delivery_events_head_fkey'
        )
        order by constraint_row.conname
      `;
      expect(foreignKeys).toEqual([
        {
          name: 'sp_write_outbox_delivery_events_head_fkey',
          child: 'sp_write_outbox_delivery_events',
          parent: 'sp_write_outbox_delivery_heads',
          definition: 'FOREIGN KEY (org_id, profile_id, outbox_id) REFERENCES app.sp_write_outbox_delivery_heads(org_id, profile_id, outbox_id) ON DELETE CASCADE',
        },
        {
          name: 'sp_write_outbox_delivery_heads_outbox_fkey',
          child: 'sp_write_outbox_delivery_heads',
          parent: 'sp_write_outbox',
          definition: 'FOREIGN KEY (org_id, profile_id, outbox_id) REFERENCES sp_write_outbox(org_id, profile_id, outbox_id) ON DELETE CASCADE',
        },
      ]);
      expect(foreignKeys.some((row) =>
        row.child === 'sp_write_outbox_delivery_events' && row.parent === 'sp_write_outbox',
      )).toBe(false);

      const functionSecurity = await database.sql<{
        name: string;
        security_definer: boolean;
        search_path: string[] | null;
      }[]>`
        select function.proname as name,
               function.prosecdef as security_definer,
               function.proconfig as search_path
        from pg_catalog.pg_proc function
        join pg_catalog.pg_namespace namespace on namespace.oid = function.pronamespace
        where namespace.nspname = 'app'
          and function.proname in (
            'claim_sp_write_outbox', 'renew_sp_write_outbox_claim',
            'defer_sp_write_outbox_claim', 'complete_sp_write_outbox_claim',
            'acquire_sp_write_dispatch_lease_for_claim',
            'reserve_sp_write_provider_call_for_claim'
          )
        order by function.proname
      `;
      expect(functionSecurity).toHaveLength(6);
      expect(functionSecurity.every((row) => row.security_definer)).toBe(true);
      expect(functionSecurity.every((row) =>
        row.search_path?.includes('search_path=pg_catalog, public, app, pg_temp') === true,
      )).toBe(true);
    } finally {
      await database.drop();
    }
  }, 60_000);

  it('closes the insert-versus-trigger-install cut with exactly one backfilled head', async () => {
    const database = await createTestDatabase('sp_write_outbox_upgrade_insert_race', {
      throughMigration: BEFORE,
      applyFixture: false,
    });
    const inserter = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    try {
      const fixture = await seedDispatchCycle(database, { createOutbox: false });
      const inserted = deferred();
      const release = deferred();
      const heldInsert = inserter.begin(async (transaction) => {
        await transaction`
          insert into public.sp_write_outbox (
            outbox_id, org_id, profile_id, execution_id, plan_id, approval_id,
            generation, kind, provider_call_id, intent_id, source_sync_job_id
          ) values (
            ${fixture.outboxId}::uuid, ${fixture.orgId}::uuid, ${fixture.profileId}::uuid,
            ${fixture.executionId}::uuid, ${fixture.planId}::uuid, ${fixture.approvalId}::uuid,
            ${fixture.generation}::uuid, 'dispatch', null, null, null
          )
        `;
        inserted.resolve();
        await release.promise;
      });
      await inserted.promise;
      const applying = applySqlFile(database, MIGRATION);
      try {
        await waitForDatabaseLock(database, 'WP-192: private');
      } finally {
        release.resolve();
      }
      await heldInsert;
      await applying;
      const [counts] = await database.sql<{ outboxes: number; heads: number; events: number }[]>`
        select
          (select count(*)::int from public.sp_write_outbox
            where outbox_id = ${fixture.outboxId}::uuid) as outboxes,
          (select count(*)::int from app.sp_write_outbox_delivery_heads
            where outbox_id = ${fixture.outboxId}::uuid) as heads,
          (select count(*)::int from app.sp_write_outbox_delivery_events
            where outbox_id = ${fixture.outboxId}::uuid) as events
      `;
      expect(counts).toEqual({ outboxes: 1, heads: 1, events: 0 });
    } finally {
      await inserter.end({ timeout: 2 }).catch(() => {});
      await database.drop();
    }
  }, 60_000);

  it('fences a 50-way claim race and gives same-claimant takeover a fresh epoch and token', async () => {
    const database = await createTestDatabase('sp_write_outbox_claim_race', { applyFixture: false });
    const race = postgres(database.connectionString, { max: 50, onnotice: () => {} });
    try {
      const fixture = await seedDispatchCycle(database);
      const batches = await Promise.all(Array.from({ length: 50 }, async () => race<DispatchClaim[]>`
        select offered_count, claimed_count, claim_ordinal, outbox_id::text,
               claim_epoch::text, claim_token::text, claimed_at, lease_expires_at
        from app.claim_sp_write_outbox(
          'wp192-racer', array['dispatch']::public.sp_write_outbox_kind[], 1, 70
        )
      `));
      const rows = batches.flat();
      expect(rows).toHaveLength(50);
      const winners = rows.filter((row) => row.claim_token !== null);
      expect(winners).toHaveLength(1);
      expect(rows.filter((row) => row.claim_token === null)).toHaveLength(49);
      expect(winners[0]).toMatchObject({
        offered_count: 1,
        claimed_count: 1,
        claim_ordinal: 1,
        outbox_id: fixture.outboxId,
        claim_epoch: '1',
      });
      const firstToken = winners[0]?.claim_token;
      expect(firstToken).toBeTruthy();
      const [projection] = await database.sql<{
        state: string;
        claim_epoch: string;
        attempt_count: string;
        transition_sequence: string;
        token_digest: string;
        events: number;
      }[]>`
        select head.state, head.claim_epoch::text, head.attempt_count::text,
               head.transition_sequence::text, head.token_digest,
               (select count(*)::int from app.sp_write_outbox_delivery_events event
                 where event.outbox_id = head.outbox_id) as events
        from app.sp_write_outbox_delivery_heads head
        where head.outbox_id = ${fixture.outboxId}::uuid
      `;
      expect(projection).toMatchObject({
        state: 'leased', claim_epoch: '1', attempt_count: '1',
        transition_sequence: '1', events: 1,
      });
      const tokenDigestDomain = [
        'openspell',
        'sp-write-outbox-claim-token',
        'sql',
        'v1',
      ].join('.');
      expect(projection?.token_digest).toBe(sha256(
        `${tokenDigestDomain}\n${firstToken}`,
      ));

      await database.sql`
        update app.sp_write_outbox_delivery_heads
        set claimed_at = clock_timestamp() - interval '2 seconds',
            lease_expires_at = clock_timestamp() - interval '1 second'
        where outbox_id = ${fixture.outboxId}::uuid
      `;
      const takeover = await claimOne(database, 'wp192-racer');
      expect(takeover).toMatchObject({
        offered_count: 1, claimed_count: 1, claim_ordinal: 1,
        outbox_id: fixture.outboxId, claim_epoch: '2',
      });
      expect(takeover.claim_token).not.toBe(firstToken);
      const events = await database.sql<{ event_kind: string; claim_epoch: string }[]>`
        select event_kind, claim_epoch::text
        from app.sp_write_outbox_delivery_events
        where outbox_id = ${fixture.outboxId}::uuid
        order by transition_sequence
      `;
      expect(events).toEqual([
        { event_kind: 'claimed', claim_epoch: '1' },
        { event_kind: 'expired_reclaimed', claim_epoch: '2' },
      ]);
    } finally {
      await race.end({ timeout: 2 }).catch(() => {});
      await database.drop();
    }
  }, 60_000);

  it('projects renewal, defer replay, replacement fencing, and completion exactly', async () => {
    const database = await createTestDatabase('sp_write_outbox_transitions', { applyFixture: false });
    try {
      const fixture = await seedDispatchCycle(database);
      const actionIds = [randomUUID(), randomUUID()] as const;
      await database.sql.begin(async (transaction) => {
        await transaction.unsafe("set local session_replication_role = 'replica'");
        for (const [index, actionId] of actionIds.entries()) {
          await transaction`
            insert into public.sp_write_plan_actions (
              org_id, profile_id, plan_id, action_id, action_index, route_key,
              amazon_entity_id, artifact_text, artifact, fingerprint_preimage, fingerprint
            ) values (
              ${fixture.orgId}::uuid, ${fixture.profileId}::uuid, ${fixture.planId}::uuid,
              ${actionId}::uuid, ${index}, 'sp.v3.keywords.update',
              ${`synthetic-entity-${index}`}, '{}', '{}'::jsonb,
              ${`action:${actionId}`}, ${sha256(`action:${actionId}`)}
            )
          `;
        }
      });
      const first = await claimOne(database, 'wp192-transitions');
      expect(first.claim_token).not.toBeNull();
      const [renewed] = await database.sql<{ decision: string; expires_at: Date | null }[]>`
        select decision, expires_at
        from app.renew_sp_write_outbox_claim(
          ${fixture.outboxId}::uuid, ${first.claim_epoch}::bigint,
          ${first.claim_token}::uuid, 120
        )
      `;
      expect(renewed?.decision).toBe('renewed');

      const [deferredResult] = await database.sql<{
        decision: string;
        reason: string;
        available_at: Date | null;
      }[]>`
        select decision, reason, available_at
        from app.defer_sp_write_outbox_claim(
          ${fixture.outboxId}::uuid, ${first.claim_epoch}::bigint,
          ${first.claim_token}::uuid, 'shutdown'
        )
      `;
      expect(deferredResult).toMatchObject({ decision: 'deferred', reason: 'shutdown' });
      const [deferReplay] = await database.sql<{ decision: string; available_at: Date | null }[]>`
        select decision, available_at
        from app.defer_sp_write_outbox_claim(
          ${fixture.outboxId}::uuid, ${first.claim_epoch}::bigint,
          ${first.claim_token}::uuid, 'shutdown'
        )
      `;
      expect(deferReplay?.decision).toBe('already_deferred');
      expect(new Date(String(deferReplay?.available_at)).toISOString()).toBe(
        new Date(String(deferredResult?.available_at)).toISOString(),
      );
      const [wrongReplay] = await database.sql<{
        decision: string;
        reason: string | null;
        available_at: Date | null;
      }[]>`
        select decision, reason, available_at
        from app.defer_sp_write_outbox_claim(
          ${fixture.outboxId}::uuid, ${first.claim_epoch}::bigint,
          ${first.claim_token}::uuid, 'reservation_busy'
        )
      `;
      expect(wrongReplay).toEqual({
        decision: 'stale_claim',
        reason: null,
        available_at: null,
      });

      await database.sql`
        update app.sp_write_outbox_delivery_heads
        set available_at = clock_timestamp() - interval '1 second'
        where outbox_id = ${fixture.outboxId}::uuid
      `;
      const replacement = await claimOne(database, 'wp192-replacement');
      expect(replacement.claim_epoch).toBe('2');
      const [staleCompletion] = await database.sql<{ decision: string }[]>`
        select decision
        from app.complete_sp_write_outbox_claim(
          ${fixture.outboxId}::uuid, ${first.claim_epoch}::bigint, ${first.claim_token}::uuid
        )
      `;
      expect(staleCompletion?.decision).toBe('stale_claim');
      const completeReplacement = async (): Promise<string | undefined> => {
        const [row] = await database.sql<{ decision: string }[]>`
          select decision from app.complete_sp_write_outbox_claim(
            ${fixture.outboxId}::uuid, ${replacement.claim_epoch}::bigint,
            ${replacement.claim_token}::uuid
          )
        `;
        return row?.decision;
      };
      expect(await completeReplacement()).toBe('not_complete');
      for (const [index, actionId] of actionIds.entries()) {
        await database.sql.begin(async (transaction) => {
          await transaction.unsafe("set local session_replication_role = 'replica'");
          await transaction`
            insert into public.sp_write_action_resolutions (
              org_id, profile_id, execution_id, plan_id, action_id,
              resolution_kind, disposition_id, intent_id, resolved_at
            ) values (
              ${fixture.orgId}::uuid, ${fixture.profileId}::uuid,
              ${fixture.executionId}::uuid, ${fixture.planId}::uuid,
              ${actionId}::uuid, 'refusal', ${randomUUID()}::uuid, null,
              clock_timestamp()
            )
          `;
        });
        expect(await completeReplacement()).toBe(index === 0 ? 'not_complete' : 'completed');
      }
      const [completed] = await database.sql<{ decision: string; completed_at: Date | null }[]>`
        select decision, completed_at
        from app.complete_sp_write_outbox_claim(
          ${fixture.outboxId}::uuid, ${replacement.claim_epoch}::bigint,
          ${replacement.claim_token}::uuid
        )
      `;
      expect(completed?.decision).toBe('already_completed');
      const [completeReplay] = await database.sql<{ decision: string; completed_at: Date | null }[]>`
        select decision, completed_at
        from app.complete_sp_write_outbox_claim(
          ${fixture.outboxId}::uuid, ${replacement.claim_epoch}::bigint,
          ${replacement.claim_token}::uuid
        )
      `;
      expect(completeReplay?.decision).toBe('already_completed');
      expect(new Date(String(completeReplay?.completed_at)).toISOString()).toBe(
        new Date(String(completed?.completed_at)).toISOString(),
      );

      const [fold] = await database.sql<{
        state: string;
        claim_epoch: string;
        attempt_count: string;
        transition_sequence: string;
        event_count: number;
        contiguous: boolean;
      }[]>`
        select head.state, head.claim_epoch::text, head.attempt_count::text,
               head.transition_sequence::text,
               count(event.*)::int as event_count,
               array_agg(event.transition_sequence order by event.transition_sequence)
                 = array[1,2,3,4,5]::bigint[] as contiguous
        from app.sp_write_outbox_delivery_heads head
        join app.sp_write_outbox_delivery_events event on event.outbox_id = head.outbox_id
        where head.outbox_id = ${fixture.outboxId}::uuid
        group by head.outbox_id
      `;
      expect(fold).toEqual({
        state: 'completed', claim_epoch: '2', attempt_count: '2',
        transition_sequence: '5', event_count: 5, contiguous: true,
      });
      await expect(database.sql`
        update app.sp_write_outbox_delivery_events set event_kind = event_kind
        where outbox_id = ${fixture.outboxId}::uuid
      `).rejects.toMatchObject({ code: '55000' });
      await expect(database.sql`
        delete from app.sp_write_outbox_delivery_heads
        where outbox_id = ${fixture.outboxId}::uuid
      `).rejects.toMatchObject({ code: '55000' });
    } finally {
      await database.drop();
    }
  }, 60_000);

  it('refuses wrong, missing, expired, and replaced custody for every token consumer', async () => {
    const database = await createTestDatabase('sp_write_outbox_custody_matrix', {
      applyFixture: false,
    });
    const consumers: readonly CustodyConsumer[] = [
      'renew',
      'defer',
      'complete',
      'acquire',
      'reserve',
    ];
    const failures = ['wrong_token', 'missing', 'expired', 'replaced'] as const;
    try {
      for (const failure of failures) {
        for (const consumer of consumers) {
          const fixture = await seedDispatchCycle(database);
          const original = await claimOne(database, `wp192-${failure}-${consumer}`);
          if (original.claim_epoch === null || original.claim_token === null) {
            throw new Error('custody matrix did not receive an exact original claim');
          }
          let presented = original;
          if (failure === 'wrong_token') {
            presented = { ...original, claim_token: randomUUID() };
          } else if (failure === 'missing') {
            await database.sql`
              delete from public.orgs where id = ${fixture.orgId}::uuid
            `;
          } else {
            await database.sql`
              update app.sp_write_outbox_delivery_heads
              set claimed_at = clock_timestamp() - interval '2 seconds',
                  lease_expires_at = clock_timestamp() - interval '1 second'
              where outbox_id = ${fixture.outboxId}::uuid
            `;
            if (failure === 'replaced') {
              const replacement = await claimOne(database, `wp192-replacement-${consumer}`);
              expect(replacement.claim_epoch).toBe('2');
              expect(replacement.claim_token).not.toBe(original.claim_token);
            }
          }

          const before = await custodySnapshot(database, fixture);
          const outcome = await invokeCustodyConsumer(
            database,
            fixture,
            presented,
            consumer,
          );
          const expected = failure === 'missing'
            ? consumer === 'renew'
              ? { decision: 'stale_claim' }
              : consumer === 'defer'
                ? { decision: 'stale_claim', reason: null, availableAt: null }
                : { code: 'P0002' }
            : consumer === 'renew' || consumer === 'complete'
              ? { decision: 'stale_claim' }
              : consumer === 'defer'
                ? { decision: 'stale_claim', reason: null, availableAt: null }
                : consumer === 'acquire'
                  ? { code: '55P03' }
                  : { decision: 'claim_unavailable' };
          expect({ failure, consumer, outcome }).toEqual({ failure, consumer, outcome: expected });
          expect(await custodySnapshot(database, fixture)).toEqual(before);

          if (failure !== 'missing') {
            await database.sql`
              delete from public.orgs where id = ${fixture.orgId}::uuid
            `;
          }
        }
      }
    } finally {
      await database.drop();
    }
  }, 60_000);

  it('keeps an observe wake open until every real result position has an observation', async () => {
    const database = await createTestDatabase('sp_write_outbox_observation_closure', {
      applyFixture: false,
    });
    try {
      const fixture = await seedDispatchCycle(database, {
        createOutbox: false,
        createRequest: true,
      });
      const actionIds = [randomUUID(), randomUUID(), randomUUID()] as const;
      const dispatchLeaseId = randomUUID();
      const predispatchObservationId = randomUUID();
      const intentId = randomUUID();
      const providerCallId = randomUUID();
      const resultId = randomUUID();
      const sourceSyncJobId = randomUUID();
      const observeOutboxId = randomUUID();
      const actionFingerprints = actionIds.map((actionId) => sha256(`action:${actionId}`));
      const providerObservationFingerprint = sha256(`predispatch:${predispatchObservationId}`);
      const requestFingerprint = sha256(`request:${intentId}`);
      const intentFingerprint = sha256(`intent:${intentId}`);
      const actionRequestFingerprints = actionIds.map((actionId) =>
        sha256(`action-request:${actionId}`));
      const resultFingerprint = sha256(`result:${resultId}`);

      await database.sql.begin(async (transaction) => {
        await transaction.unsafe("set local session_replication_role = 'replica'");
        for (const [index, actionId] of actionIds.entries()) {
          await transaction`
            insert into public.sp_write_plan_actions (
              org_id, profile_id, plan_id, action_id, action_index, route_key,
              amazon_entity_id, artifact_text, artifact, fingerprint_preimage, fingerprint
            ) values (
              ${fixture.orgId}::uuid, ${fixture.profileId}::uuid, ${fixture.planId}::uuid,
              ${actionId}::uuid, ${index}, 'sp.v3.keywords.update',
              ${`synthetic-entity-${index}`}, '{}', '{}'::jsonb,
              ${`action:${actionId}`}, ${actionFingerprints[index]!}
            )
          `;
        }
        await transaction`
          insert into public.sp_write_dispatch_leases (
            lease_id, org_id, profile_id, execution_id, plan_id, approval_id,
            generation, route_key, acquired_at, expires_at
          ) values (
            ${dispatchLeaseId}::uuid, ${fixture.orgId}::uuid, ${fixture.profileId}::uuid,
            ${fixture.executionId}::uuid, ${fixture.planId}::uuid, ${fixture.approvalId}::uuid,
            ${fixture.generation}::uuid, 'sp.v3.keywords.update',
            clock_timestamp() - interval '2 minutes', clock_timestamp() - interval '30 seconds'
          )
        `;
        await transaction`
          insert into public.sp_write_predispatch_observations (
            observation_id, org_id, profile_id, execution_id, plan_id, approval_id,
            generation, route_key, observed_at, valid_until, artifact_text, artifact,
            fingerprint_preimage, fingerprint
          ) values (
            ${predispatchObservationId}::uuid, ${fixture.orgId}::uuid,
            ${fixture.profileId}::uuid, ${fixture.executionId}::uuid,
            ${fixture.planId}::uuid, ${fixture.approvalId}::uuid, ${fixture.generation}::uuid,
            'sp.v3.keywords.update', clock_timestamp() - interval '1 minute',
            clock_timestamp() + interval '30 seconds', '{}', '{}'::jsonb,
            ${`predispatch:${predispatchObservationId}`}, ${providerObservationFingerprint}
          )
        `;
        await transaction`
          with intent_times as materialized (
            select clock_timestamp() - interval '60 seconds' as checked_at
          )
          insert into public.sp_write_provider_call_intents (
            intent_id, provider_call_id, reserved_result_id, org_id, profile_id,
            execution_id, plan_id, approval_id, generation, route_key, attempt_number,
            dispatch_lease_id, provider_observation_fingerprint,
            request_fingerprint_preimage, request_fingerprint,
            intent_fingerprint_preimage, fingerprint, artifact_text, artifact,
            recorded_at, checked_at, dispatch_start_deadline, provider_attempt_deadline
          ) select
            ${intentId}::uuid, ${providerCallId}::uuid, ${resultId}::uuid,
            ${fixture.orgId}::uuid, ${fixture.profileId}::uuid,
            ${fixture.executionId}::uuid, ${fixture.planId}::uuid,
            ${fixture.approvalId}::uuid, ${fixture.generation}::uuid,
            'sp.v3.keywords.update', 1, ${dispatchLeaseId}::uuid,
            ${providerObservationFingerprint}, ${`request:${intentId}`}, ${requestFingerprint},
            ${`intent:${intentId}`}, ${intentFingerprint}, '{}', '{}'::jsonb,
            checked_at - interval '1 second', checked_at,
            checked_at + interval '5 seconds', checked_at + interval '35 seconds'
          from intent_times
        `;
        for (const [index, actionId] of actionIds.entries()) {
          await transaction`
            insert into public.sp_write_provider_call_positions (
              org_id, profile_id, execution_id, plan_id, intent_id, request_index,
              action_id, action_fingerprint, amazon_entity_id, action_request_fingerprint
            ) values (
              ${fixture.orgId}::uuid, ${fixture.profileId}::uuid,
              ${fixture.executionId}::uuid, ${fixture.planId}::uuid, ${intentId}::uuid,
              ${index}, ${actionId}::uuid, ${actionFingerprints[index]!},
              ${`synthetic-entity-${index}`}, ${actionRequestFingerprints[index]!}
            )
          `;
        }
        await transaction`
          insert into public.sp_write_outbox (
            outbox_id, org_id, profile_id, execution_id, plan_id, approval_id,
            generation, kind, provider_call_id, intent_id, source_sync_job_id
          ) values (
            ${observeOutboxId}::uuid, ${fixture.orgId}::uuid, ${fixture.profileId}::uuid,
            ${fixture.executionId}::uuid, ${fixture.planId}::uuid,
            ${fixture.approvalId}::uuid, ${fixture.generation}::uuid,
            'observe_and_recover', ${providerCallId}::uuid, ${intentId}::uuid,
            ${sourceSyncJobId}::uuid
          )
        `;
        await transaction`
          insert into app.sp_write_outbox_delivery_heads (
            org_id, profile_id, outbox_id, state, claim_epoch,
            transition_sequence, available_at, attempt_count
          ) values (
            ${fixture.orgId}::uuid, ${fixture.profileId}::uuid, ${observeOutboxId}::uuid,
            'available', 0, 0, clock_timestamp(), 0
          )
        `;
      });

      const [claim] = await database.sql<DispatchClaim[]>`
        select offered_count, claimed_count, claim_ordinal, outbox_id::text,
               claim_epoch::text, claim_token::text, claimed_at, lease_expires_at
        from app.claim_sp_write_outbox(
          'wp192-observer', array['observe_and_recover']::public.sp_write_outbox_kind[], 1, 70
        )
      `;
      expect(claim).toMatchObject({
        offered_count: 1,
        claimed_count: 1,
        claim_ordinal: 1,
        outbox_id: observeOutboxId,
        claim_epoch: '1',
      });
      if (claim?.claim_token === null || claim?.claim_token === undefined) {
        throw new Error('observe fixture did not return a claim token');
      }
      const [notComplete] = await database.sql<{ decision: string }[]>`
        select decision
        from app.complete_sp_write_outbox_claim(
          ${observeOutboxId}::uuid, ${claim.claim_epoch}::bigint, ${claim.claim_token}::uuid
        )
      `;
      expect(notComplete?.decision).toBe('not_complete');

      const completeObserve = async (): Promise<string | undefined> => {
        const [row] = await database.sql<{ decision: string }[]>`
          select decision from app.complete_sp_write_outbox_claim(
            ${observeOutboxId}::uuid, ${claim.claim_epoch}::bigint,
            ${claim.claim_token}::uuid
          )
        `;
        return row?.decision;
      };
      await database.sql.begin(async (transaction) => {
        await transaction.unsafe("set local session_replication_role = 'replica'");
        await transaction`
          insert into public.sp_write_provider_results (
            result_id, org_id, profile_id, intent_id, origin, artifact_text, artifact,
            fingerprint_preimage, fingerprint, intent_fingerprint, provider_call_id,
            request_fingerprint, completed_at
          ) values (
            ${resultId}::uuid, ${fixture.orgId}::uuid, ${fixture.profileId}::uuid,
            ${intentId}::uuid, 'provider_adapter', '{}', '{}'::jsonb,
            ${`result:${resultId}`}, ${resultFingerprint}, ${intentFingerprint},
            ${providerCallId}::uuid, ${requestFingerprint},
            clock_timestamp() - interval '1 second'
          )
        `;
        for (const index of [0, 1] as const) {
          await transaction`
            insert into public.sp_write_provider_result_positions (
              org_id, profile_id, result_id, intent_id, request_index, action_id,
              action_fingerprint, action_request_fingerprint, outcome, provider_entity_id
            ) values (
              ${fixture.orgId}::uuid, ${fixture.profileId}::uuid, ${resultId}::uuid,
              ${intentId}::uuid, ${index}, ${actionIds[index]}::uuid,
              ${actionFingerprints[index]!}, ${actionRequestFingerprints[index]!},
              ${index === 0 ? 'accepted' : 'ambiguous'}::public.sp_write_provider_outcome,
              ${index === 0 ? 'synthetic-entity-0' : null}
            )
          `;
        }
      });
      expect(await completeObserve()).toBe('not_complete');

      await database.sql.begin(async (transaction) => {
        await transaction.unsafe("set local session_replication_role = 'replica'");
        await transaction`
          insert into public.sp_write_provider_result_positions (
            org_id, profile_id, result_id, intent_id, request_index, action_id,
            action_fingerprint, action_request_fingerprint, outcome, provider_entity_id
          ) values (
            ${fixture.orgId}::uuid, ${fixture.profileId}::uuid, ${resultId}::uuid,
            ${intentId}::uuid, 2, ${actionIds[2]}::uuid, ${actionFingerprints[2]!},
            ${actionRequestFingerprints[2]!}, 'authoritative_rejected', null
          )
        `;
      });
      expect(await completeObserve()).toBe('not_complete');

      const insertObservation = async (
        actionIndex: 0 | 1,
        observationSourceSyncJobId: string,
      ): Promise<void> => {
        const observationId = randomUUID();
        const preimage = `observation:${observationId}`;
        await database.sql.begin(async (transaction) => {
          await transaction.unsafe("set local session_replication_role = 'replica'");
          await transaction`
            insert into public.sp_write_observations (
              observation_id, org_id, profile_id, execution_id, plan_id, approval_id,
              generation, intent_id, result_id, provider_call_id, action_id,
              action_fingerprint, intent_fingerprint, request_fingerprint, route_key,
              source_sync_job_id, outcome, observed, observed_at, artifact_text, artifact,
              fingerprint_preimage, fingerprint
            ) values (
              ${observationId}::uuid, ${fixture.orgId}::uuid, ${fixture.profileId}::uuid,
              ${fixture.executionId}::uuid, ${fixture.planId}::uuid,
              ${fixture.approvalId}::uuid, ${fixture.generation}::uuid,
              ${intentId}::uuid, ${resultId}::uuid, ${providerCallId}::uuid,
              ${actionIds[actionIndex]}::uuid, ${actionFingerprints[actionIndex]!},
              ${intentFingerprint}, ${requestFingerprint}, 'sp.v3.keywords.update',
              ${observationSourceSyncJobId}::uuid,
              ${actionIndex === 0 ? 'observed_requested' : 'missing'}
                ::public.sp_write_observation_outcome,
              ${actionIndex === 0 ? '{}' : null}::jsonb,
              clock_timestamp() - interval '1 second', '{}', '{}'::jsonb,
              ${preimage}, ${sha256(preimage)}
            )
          `;
        });
      };
      await insertObservation(0, randomUUID());
      expect(await completeObserve()).toBe('not_complete');
      await database.sql.begin(async (transaction) => {
        await transaction.unsafe("set local session_replication_role = 'replica'");
        await transaction`
          delete from public.sp_write_observations
          where intent_id = ${intentId}::uuid and action_id = ${actionIds[0]}::uuid
        `;
      });
      await insertObservation(0, sourceSyncJobId);
      expect(await completeObserve()).toBe('not_complete');
      await insertObservation(1, sourceSyncJobId);

      const [completed] = await database.sql<{ decision: string }[]>`
        select decision
        from app.complete_sp_write_outbox_claim(
          ${observeOutboxId}::uuid, ${claim.claim_epoch}::bigint, ${claim.claim_token}::uuid
        )
      `;
      expect(completed?.decision).toBe('completed');
      const [projection] = await database.sql<{
        state: string;
        event_count: number;
        intent_positions: number;
        result_positions: number;
        observations: number;
        exact_source_observations: number;
        rejected_observations: number;
      }[]>`
        select head.state,
               (select count(*)::int from app.sp_write_outbox_delivery_events event
                 where event.outbox_id = head.outbox_id) as event_count,
               (select count(*)::int from public.sp_write_provider_call_positions position
                 where position.intent_id = ${intentId}::uuid) as intent_positions,
               (select count(*)::int from public.sp_write_provider_result_positions position
                 where position.intent_id = ${intentId}::uuid) as result_positions,
               (select count(*)::int from public.sp_write_observations observation
                 where observation.intent_id = ${intentId}::uuid) as observations,
               (select count(*)::int from public.sp_write_observations observation
                 where observation.intent_id = ${intentId}::uuid
                   and observation.source_sync_job_id = ${sourceSyncJobId}::uuid)
                 as exact_source_observations,
               (select count(*)::int from public.sp_write_observations observation
                 where observation.intent_id = ${intentId}::uuid
                   and observation.action_id = ${actionIds[2]}::uuid) as rejected_observations
        from app.sp_write_outbox_delivery_heads head
        where head.outbox_id = ${observeOutboxId}::uuid
      `;
      expect(projection).toEqual({
        state: 'completed',
        event_count: 2,
        intent_positions: 3,
        result_positions: 3,
        observations: 2,
        exact_source_observations: 2,
        rejected_observations: 0,
      });
    } finally {
      await database.drop();
    }
  }, 60_000);

  it('rejects every NULL/UNKNOWN escape in leased-head and event shapes', async () => {
    const database = await createTestDatabase('sp_write_outbox_null_shapes', { applyFixture: false });
    try {
      const fixture = await seedDispatchCycle(database);
      await expect(database.sql`
        update app.sp_write_outbox_delivery_heads
        set state = 'leased', claim_epoch = 1, attempt_count = 1,
            transition_sequence = 1, claimant_id = 'shape-probe',
            token_digest = null, available_at = null,
            claimed_at = clock_timestamp(),
            lease_expires_at = clock_timestamp() + interval '70 seconds'
        where outbox_id = ${fixture.outboxId}::uuid
      `).rejects.toMatchObject({
        code: '23514',
        constraint_name: 'sp_write_outbox_delivery_heads_shape_check',
      });

      const expectMalformedEvent = async (
        kind: string,
        claimedAt: string,
        leaseExpiresAt: string,
        availableAt: string,
        completedAt: string,
        deferReason: string,
      ): Promise<void> => {
        await expect(database.sql.unsafe(`
          insert into app.sp_write_outbox_delivery_events (
            org_id, profile_id, outbox_id, transition_sequence, claim_epoch,
            event_kind, actor_claimant_id, actor_token_digest, recorded_at,
            claimed_at, lease_expires_at, available_at, completed_at, defer_reason
          ) values (
            '${fixture.orgId}'::uuid, '${fixture.profileId}'::uuid, '${fixture.outboxId}'::uuid,
            1, 1, '${kind}', 'shape-probe', '${'a'.repeat(64)}', clock_timestamp(),
            ${claimedAt}, ${leaseExpiresAt}, ${availableAt}, ${completedAt}, ${deferReason}
          )
        `)).rejects.toMatchObject({
          code: '23514',
          constraint_name: 'sp_write_outbox_delivery_events_shape_check',
        });
      };
      await expectMalformedEvent('claimed', 'null', 'null', 'null', 'null', 'null');
      await expectMalformedEvent(
        'renewed', 'clock_timestamp()', 'null', 'null', 'null', 'null',
      );
      await expectMalformedEvent('deferred', 'null', 'null', 'null', 'null', 'null');
      await expectMalformedEvent('completed', 'null', 'null', 'null', 'null', 'null');
    } finally {
      await database.drop();
    }
  }, 60_000);

  it('rolls back a dispatch lease when custody expires in the nested lock wait', async () => {
    const database = await createTestDatabase('sp_write_outbox_lease_expiry', { applyFixture: false });
    const blocker = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    const caller = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    try {
      const fixture = await seedDispatchCycle(database, { createRequest: true });
      const claim = await claimOne(database, 'wp192-lease-expiry');
      await database.sql`
        update app.sp_write_outbox_delivery_heads
        set claimed_at = clock_timestamp() - interval '2 seconds',
            lease_expires_at = clock_timestamp() + interval '500 milliseconds'
        where outbox_id = ${fixture.outboxId}::uuid
      `;

      const locked = deferred();
      const release = deferred();
      const blockerWork = blocker.begin(async (transaction) => {
        await transaction`
          select 1
          from public.sp_write_execution_requests request
          where request.org_id = ${fixture.orgId}::uuid
            and request.profile_id = ${fixture.profileId}::uuid
            and request.execution_id = ${fixture.executionId}::uuid
            and request.plan_id = ${fixture.planId}::uuid
          for update
        `;
        locked.resolve();
        await release.promise;
      });
      await locked.promise;
      const call = caller`
        select *
        from app.acquire_sp_write_dispatch_lease_for_claim(
          ${fixture.outboxId}::uuid, ${claim.claim_epoch}::bigint,
          ${claim.claim_token}::uuid, 'sp.v3.keywords.update', 70
        )
      `.then(() => undefined, (error: unknown) => error);
      await waitForDatabaseLock(database, 'acquire_sp_write_dispatch_lease_for_claim');
      await new Promise((resolve) => setTimeout(resolve, 700));
      release.resolve();
      await blockerWork;
      expect(await call).toMatchObject({ code: '40001' });
      const [counts] = await database.sql<{ leases: number; events: number }[]>`
        select
          (select count(*)::int from public.sp_write_dispatch_leases
            where execution_id = ${fixture.executionId}::uuid) as leases,
          (select count(*)::int from app.sp_write_outbox_delivery_events
            where outbox_id = ${fixture.outboxId}::uuid) as events
      `;
      expect(counts).toEqual({ leases: 0, events: 1 });
    } finally {
      await blocker.end({ timeout: 2 }).catch(() => {});
      await caller.end({ timeout: 2 }).catch(() => {});
      await database.drop();
    }
  }, 60_000);

  it('rolls back all nested reservation work when custody expires after its lock wait', async () => {
    const database = await createTestDatabase('sp_write_outbox_reservation_expiry', {
      applyFixture: false,
    });
    const blocker = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    const caller = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    try {
      const fixture = await seedDispatchCycle(database, { createRequest: true });
      const claim = await claimOne(database, 'wp192-reservation-expiry');
      await database.sql`
        update app.sp_write_outbox_delivery_heads
        set claimed_at = clock_timestamp() - interval '2 seconds',
            lease_expires_at = clock_timestamp() + interval '500 milliseconds'
        where outbox_id = ${fixture.outboxId}::uuid
      `;
      await database.sql.unsafe(`
        create table app.wp192_reservation_rollback_probe (
          probe_id uuid primary key default gen_random_uuid()
        );
        -- This disposable replacement isolates the outer wrapper's post-call
        -- cut. WP-187's own suite proves the canonical reservation branches;
        -- this probe takes its real downstream lock and writes both a real
        -- immutable WP-187 lease row and a sentinel before the outer 40001.
        create or replace function app.reserve_sp_write_provider_call(
          p_execution_id uuid,
          p_plan_id uuid,
          p_generation uuid,
          p_dispatch_lease_id uuid,
          p_predispatch_observation_text text,
          p_predispatch_observation_preimage text,
          p_intent_text text,
          p_request_fingerprint_preimage text,
          p_intent_preimage text
        ) returns table (
          decision text, refusal_reason text, checked_at timestamptz,
          result_id uuid, intent_text text
        ) language plpgsql security definer
        set search_path = pg_catalog, public, app, pg_temp
        as $probe$
        declare
          v_request public.sp_write_execution_requests%rowtype;
          v_now timestamptz;
        begin
          perform app.assert_service_role('wp192_reservation_rollback_probe');
          select * into strict v_request
          from public.sp_write_execution_requests request
          where request.execution_id = p_execution_id
            and request.plan_id = p_plan_id
            and request.generation = p_generation
          for update;
          v_now := clock_timestamp();
          insert into public.sp_write_dispatch_leases (
            lease_id, org_id, profile_id, execution_id, plan_id, approval_id,
            generation, route_key, acquired_at, expires_at
          ) values (
            gen_random_uuid(), v_request.org_id, v_request.profile_id,
            v_request.execution_id, v_request.plan_id, v_request.approval_id,
            v_request.generation, 'sp.v3.keywords.update', v_now,
            v_now + interval '70 seconds'
          );
          insert into app.wp192_reservation_rollback_probe default values;
          decision := 'busy';
          refusal_reason := null;
          checked_at := clock_timestamp();
          result_id := null;
          intent_text := null;
          return next;
        end;
        $probe$;
      `);

      const locked = deferred();
      const release = deferred();
      const blockerWork = blocker.begin(async (transaction) => {
        await transaction`
          select 1
          from public.sp_write_execution_requests request
          where request.execution_id = ${fixture.executionId}::uuid
            and request.plan_id = ${fixture.planId}::uuid
          for update
        `;
        locked.resolve();
        await release.promise;
      });
      await locked.promise;
      const call = caller`
        select *
        from app.reserve_sp_write_provider_call_for_claim(
          ${fixture.outboxId}::uuid, ${claim.claim_epoch}::bigint,
          ${claim.claim_token}::uuid, ${fixture.executionId}::uuid,
          ${fixture.planId}::uuid, ${fixture.generation}::uuid,
          ${randomUUID()}::uuid, 'probe', 'probe', 'probe', 'probe', 'probe'
        )
      `.then(() => undefined, (error: unknown) => error);
      await waitForDatabaseLock(database, 'reserve_sp_write_provider_call_for_claim');
      await new Promise((resolve) => setTimeout(resolve, 700));
      release.resolve();
      await blockerWork;
      expect(await call).toMatchObject({ code: '40001' });
      const [counts] = await database.sql<{
        probe: number;
        dispositions: number;
        resolutions: number;
        intents: number;
        outboxes: number;
        heads: number;
        events: number;
        leases: number;
      }[]>`
        select
          (select count(*)::int from app.wp192_reservation_rollback_probe) as probe,
          (select count(*)::int from public.sp_write_predispatch_dispositions) as dispositions,
          (select count(*)::int from public.sp_write_action_resolutions) as resolutions,
          (select count(*)::int from public.sp_write_provider_call_intents) as intents,
          (select count(*)::int from public.sp_write_dispatch_leases) as leases,
          (select count(*)::int from public.sp_write_outbox) as outboxes,
          (select count(*)::int from app.sp_write_outbox_delivery_heads) as heads,
          (select count(*)::int from app.sp_write_outbox_delivery_events) as events
      `;
      expect(counts).toEqual({
        probe: 0, dispositions: 0, resolutions: 0, intents: 0,
        leases: 0, outboxes: 1, heads: 1, events: 1,
      });
      const [stale] = await database.sql<{ decision: string; result_id: string | null }[]>`
        select decision, result_id::text
        from app.reserve_sp_write_provider_call_for_claim(
          ${fixture.outboxId}::uuid, ${claim.claim_epoch}::bigint,
          ${claim.claim_token}::uuid, ${fixture.executionId}::uuid,
          ${fixture.planId}::uuid, ${fixture.generation}::uuid,
          ${randomUUID()}::uuid, 'malformed-but-unreached', 'unreached',
          'unreached', 'unreached', 'unreached'
        )
      `;
      expect(stale).toEqual({ decision: 'claim_unavailable', result_id: null });
      const [afterStale] = await database.sql<{ probe: number; leases: number }[]>`
        select
          (select count(*)::int from app.wp192_reservation_rollback_probe) as probe,
          (select count(*)::int from public.sp_write_dispatch_leases) as leases
      `;
      expect(afterStale).toEqual({ probe: 0, leases: 0 });
    } finally {
      await blocker.end({ timeout: 2 }).catch(() => {});
      await caller.end({ timeout: 2 }).catch(() => {});
      await database.drop();
    }
  }, 60_000);

  it('lets purge wait on a head transition, then cascades head and journal without deadlock', async () => {
    const database = await createTestDatabase('sp_write_outbox_purge_race', { applyFixture: false });
    const holder = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    const deleter = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    try {
      const fixture = await seedDispatchCycle(database);
      const claim = await claimOne(database, 'wp192-purge-race');
      const transitioned = deferred();
      const release = deferred();
      const heldTransition = holder.begin(async (transaction) => {
        await transaction`
          select * from app.renew_sp_write_outbox_claim(
            ${fixture.outboxId}::uuid, ${claim.claim_epoch}::bigint,
            ${claim.claim_token}::uuid, 120
          )
        `;
        transitioned.resolve();
        await release.promise;
      });
      await transitioned.promise;
      const deletion = deleter`
        delete /* wp192_purge_wait */ from public.orgs where id = ${fixture.orgId}::uuid
      `.then((rows) => rows);
      try {
        await waitForDatabaseLock(database, 'wp192_purge_wait');
      } finally {
        release.resolve();
      }
      await heldTransition;
      await deletion;
      const [counts] = await database.sql<{ outboxes: number; heads: number; events: number }[]>`
        select
          (select count(*)::int from public.sp_write_outbox
            where outbox_id = ${fixture.outboxId}::uuid) as outboxes,
          (select count(*)::int from app.sp_write_outbox_delivery_heads
            where outbox_id = ${fixture.outboxId}::uuid) as heads,
          (select count(*)::int from app.sp_write_outbox_delivery_events
            where outbox_id = ${fixture.outboxId}::uuid) as events
      `;
      expect(counts).toEqual({ outboxes: 0, heads: 0, events: 0 });
    } finally {
      await holder.end({ timeout: 2 }).catch(() => {});
      await deleter.end({ timeout: 2 }).catch(() => {});
      await database.drop();
    }
  }, 60_000);

  it('serializes purge after defer and completion transitions, then cascades their journals', async () => {
    const database = await createTestDatabase('sp_write_outbox_transition_purge_matrix', {
      applyFixture: false,
    });
    const holder = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    const deleter = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    try {
      for (const transition of ['defer', 'complete'] as const) {
        const fixture = await seedDispatchCycle(database);
        const claim = await claimOne(database, `wp192-${transition}-purge`);
        if (claim.claim_epoch === null || claim.claim_token === null) {
          throw new Error('transition-purge fixture did not return exact custody');
        }
        const transitioned = deferred();
        const release = deferred();
        const heldTransition = holder.begin(async (transaction) => {
          const [row] = transition === 'defer'
            ? await transaction<{ decision: string }[]>`
                select decision from app.defer_sp_write_outbox_claim(
                  ${fixture.outboxId}::uuid, ${claim.claim_epoch}::bigint,
                  ${claim.claim_token}::uuid, 'shutdown'
                )
              `
            : await transaction<{ decision: string }[]>`
                select decision from app.complete_sp_write_outbox_claim(
                  ${fixture.outboxId}::uuid, ${claim.claim_epoch}::bigint,
                  ${claim.claim_token}::uuid
                )
              `;
          transitioned.resolve();
          await release.promise;
          return row;
        });
        await transitioned.promise;
        const deletion = transition === 'defer'
          ? deleter`
              delete /* wp192_defer_purge_wait */ from public.orgs
              where id = ${fixture.orgId}::uuid
            `.then((rows) => rows)
          : deleter`
              delete /* wp192_complete_purge_wait */ from public.orgs
              where id = ${fixture.orgId}::uuid
            `.then((rows) => rows);
        try {
          await waitForDatabaseLock(
            database,
            transition === 'defer'
              ? 'wp192_defer_purge_wait'
              : 'wp192_complete_purge_wait',
          );
        } finally {
          release.resolve();
        }
        expect(await heldTransition).toMatchObject({
          decision: transition === 'defer' ? 'deferred' : 'completed',
        });
        await deletion;
        expect(await custodySnapshot(database, fixture)).toEqual({
          outboxes: 0,
          heads: 0,
          events: 0,
          leases: 0,
          dispositions: 0,
          resolutions: 0,
          intents: 0,
        });
      }
    } finally {
      await holder.end({ timeout: 2 }).catch(() => {});
      await deleter.end({ timeout: 2 }).catch(() => {});
      await database.drop();
    }
  }, 60_000);

  it('lets a claim-bound lease finish before purge and then cascades the committed lease', async () => {
    const database = await createTestDatabase('sp_write_outbox_lease_purge', {
      applyFixture: false,
    });
    const blocker = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    const caller = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    const deleter = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    try {
      const fixture = await seedDispatchCycle(database, { createRequest: true });
      const claim = await claimOne(database, 'wp192-lease-purge');
      if (claim.claim_epoch === null || claim.claim_token === null) {
        throw new Error('lease-purge fixture did not return exact custody');
      }
      const locked = deferred();
      const release = deferred();
      const blockerWork = blocker.begin(async (transaction) => {
        await transaction`
          select 1 from public.sp_write_execution_requests request
          where request.org_id = ${fixture.orgId}::uuid
            and request.profile_id = ${fixture.profileId}::uuid
            and request.execution_id = ${fixture.executionId}::uuid
            and request.plan_id = ${fixture.planId}::uuid
          for update
        `;
        locked.resolve();
        await release.promise;
      });
      await locked.promise;
      const leaseCall = caller<{ lease_id: string }[]>`
          select lease_id::text from app.acquire_sp_write_dispatch_lease_for_claim(
            ${fixture.outboxId}::uuid, ${claim.claim_epoch}::bigint,
            ${claim.claim_token}::uuid, 'sp.v3.keywords.update', 70
          )
        `.then((rows) => rows);
      await waitForDatabaseLock(database, 'acquire_sp_write_dispatch_lease_for_claim');
      const deletion = deleter`
        delete /* wp192_lease_wrapper_purge_wait */ from public.orgs
        where id = ${fixture.orgId}::uuid
      `.then((rows) => rows);
      try {
        await waitForDatabaseLock(database, 'wp192_lease_wrapper_purge_wait');
      } finally {
        release.resolve();
      }
      await blockerWork;
      const [lease] = await leaseCall;
      expect(lease?.lease_id).toMatch(/^[0-9a-f-]{36}$/u);
      await deletion;
      expect(await custodySnapshot(database, fixture)).toEqual({
        outboxes: 0,
        heads: 0,
        events: 0,
        leases: 0,
        dispositions: 0,
        resolutions: 0,
        intents: 0,
      });
    } finally {
      await blocker.end({ timeout: 2 }).catch(() => {});
      await caller.end({ timeout: 2 }).catch(() => {});
      await deleter.end({ timeout: 2 }).catch(() => {});
      await database.drop();
    }
  }, 60_000);

  it('allows a claimed handle to vanish when tenant purge wins after claim commit', async () => {
    const database = await createTestDatabase('sp_write_outbox_claim_purge', { applyFixture: false });
    const claimer = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    const deleter = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    try {
      const fixture = await seedDispatchCycle(database);
      const claimed = deferred();
      const release = deferred();
      const heldClaim = claimer.begin(async (transaction) => {
        const [row] = await transaction<DispatchClaim[]>`
          select offered_count, claimed_count, claim_ordinal, outbox_id::text,
                 claim_epoch::text, claim_token::text, claimed_at, lease_expires_at
          from app.claim_sp_write_outbox(
            'wp192-claim-purge', array['dispatch']::public.sp_write_outbox_kind[], 1, 70
          )
        `;
        claimed.resolve();
        await release.promise;
        return row;
      });
      await claimed.promise;
      const deletion = deleter`
        delete /* wp192_claim_purge_wait */ from public.orgs
        where id = ${fixture.orgId}::uuid
      `.then((rows) => rows);
      try {
        await waitForDatabaseLock(database, 'wp192_claim_purge_wait');
      } finally {
        release.resolve();
      }
      const claim = await heldClaim;
      expect(claim?.claim_token).not.toBeNull();
      if (claim?.claim_epoch === null || claim?.claim_epoch === undefined
          || claim.claim_token === null) {
        throw new Error('claim-purge fixture did not return exact custody');
      }
      await deletion;
      const [counts] = await database.sql<{ outboxes: number; heads: number; events: number }[]>`
        select
          (select count(*)::int from public.sp_write_outbox
            where outbox_id = ${fixture.outboxId}::uuid) as outboxes,
          (select count(*)::int from app.sp_write_outbox_delivery_heads
            where outbox_id = ${fixture.outboxId}::uuid) as heads,
          (select count(*)::int from app.sp_write_outbox_delivery_events
            where outbox_id = ${fixture.outboxId}::uuid) as events
      `;
      expect(counts).toEqual({ outboxes: 0, heads: 0, events: 0 });
      await expect(database.sql`
        select * from app.acquire_sp_write_dispatch_lease_for_claim(
          ${fixture.outboxId}::uuid, ${claim.claim_epoch}::bigint,
          ${claim.claim_token}::uuid, 'sp.v3.keywords.update', 70
        )
      `).rejects.toMatchObject({ code: 'P0002' });
      await expect(database.sql`
        select * from app.reserve_sp_write_provider_call_for_claim(
          ${fixture.outboxId}::uuid, ${claim.claim_epoch}::bigint,
          ${claim.claim_token}::uuid, ${fixture.executionId}::uuid,
          ${fixture.planId}::uuid, ${fixture.generation}::uuid,
          ${randomUUID()}::uuid, 'unreached', 'unreached', 'unreached',
          'unreached', 'unreached'
        )
      `).rejects.toMatchObject({ code: 'P0002' });
      expect(await custodySnapshot(database, fixture)).toEqual({
        outboxes: 0,
        heads: 0,
        events: 0,
        leases: 0,
        dispositions: 0,
        resolutions: 0,
        intents: 0,
      });
    } finally {
      await claimer.end({ timeout: 2 }).catch(() => {});
      await deleter.end({ timeout: 2 }).catch(() => {});
      await database.drop();
    }
  }, 60_000);
});
