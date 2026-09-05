/**
 * WP-30 Time Machine query suite.
 *
 * The tenant fixture seeds each org one sync-detected `entity_changes` row
 * (keyword kw-1, bid 0.80→0.90) and one operator `apply_batch`/`apply_row`
 * (keyword, bid 0.90→0.70). These tests add an org-A-only campaign-budget change
 * so the two sources, the filters, and — the load-bearing one — org scoping are
 * each asserted against a known row count rather than a shape.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, databaseAvailable } from '../testing/harness.js';
import type { TestDatabase } from '../testing/harness.js';
import { seedSyntheticWriteHistory } from '../testing/sp-write-synthetic-execution.js';
import { reconcileEntityChangeLinks, recordEntityChanges } from './entities.js';
import {
  createReversionExport,
  getReversionBatchPreview,
  listReversionBatches,
  listTimeline,
  listTimelineFacets,
} from './time-machine.js';

const available = await databaseAvailable();
const USER_A = '71717171-7171-4171-8171-717171717171';
const USER_B = '72727272-7272-4272-8272-727272727272';

it.skipIf(!available)('retains an ordinary sync event after legacy linking to a native source batch', async () => {
  const database = await createTestDatabase('native_link_history');
  try {
    const [tenant] = await database.sql<{ id: string }[]>`select app.seed_tenant_fixture('native-link-history', ${USER_A}, 'owner') as id`;
    const orgId = tenant!.id;
    const [profile] = await database.sql<{ id: string }[]>`select id from public.ad_profiles where org_id = ${orgId}`;
    const profileId = profile!.id;
    const history = await seedSyntheticWriteHistory(database, { orgId, userId: USER_A }, profileId);
    const before = await listTimeline(database, { orgId, profileId });
    expect(before.filter((entry) => entry.write !== null)).toHaveLength(2);
    const inserted = await database.sql<{ id: string }[]>`insert into public.entity_changes
      (org_id, profile_id, entity_type, amazon_id, entity_name, field, old_value, new_value, source, observed_at)
      select org_id, profile_id, entity_type::text::public.entity_type, entity_id, entity_name, field,
        old_value, new_value, 'sync', clock_timestamp()
      from public.apply_rows where batch_id = ${history.sourceBatchId} returning id::text`;
    expect(inserted).toHaveLength(1);
    const id = inserted[0]!.id;
    expect(await listTimeline(database, { orgId, profileId })).toHaveLength(before.length + 1);
    expect(await reconcileEntityChangeLinks(database, { orgId, profileId })).toMatchObject({ offered: 1, linked: 1 });
    const [linked] = await database.sql<{ batch: string; receipt: boolean }[]>`select apply_batch_id::text as batch,
      exists(select 1 from public.sp_write_mirror_observations where entity_change_id = ${id}::bigint) as receipt
      from public.entity_changes where id = ${id}::bigint`;
    expect(linked).toEqual({ batch: history.sourceBatchId, receipt: false });
    const after = await listTimeline(database, { orgId, profileId });
    expect(after).toHaveLength(before.length + 1);
    expect(after.find((entry) => entry.id === `change:${id}`)?.source).toBe('sync');
    expect(after.filter((entry) => entry.write !== null).map((entry) => entry.id))
      .toEqual(before.filter((entry) => entry.write !== null).map((entry) => entry.id));
  } finally { await database.drop(); }
}, 60_000);

describe.skipIf(!available)('WP-30 Time Machine queries', () => {
  let database: TestDatabase;
  let orgA: string;
  let orgB: string;
  let profileA: string;
  let profileB: string;

  beforeAll(async () => {
    database = await createTestDatabase('wp30_time_machine');
    const [a] = await database.sql<{ seed_tenant_fixture: string }[]>`
      select app.seed_tenant_fixture('tm-alpha', ${USER_A}, 'owner')
    `;
    const [b] = await database.sql<{ seed_tenant_fixture: string }[]>`
      select app.seed_tenant_fixture('tm-bravo', ${USER_B}, 'owner')
    `;
    orgA = a?.seed_tenant_fixture ?? '';
    orgB = b?.seed_tenant_fixture ?? '';
    const [pa] = await database.sql<{ id: string }[]>`
      select id from public.ad_profiles where org_id = ${orgA} limit 1
    `;
    profileA = pa?.id ?? '';
    const [pb] = await database.sql<{ id: string }[]>`
      select id from public.ad_profiles where org_id = ${orgB} limit 1
    `;
    profileB = pb?.id ?? '';

    // Org A only: a campaign-budget change, so entity-type and field filters and
    // the cross-tenant test all have something org B lacks.
    await database.sql`
      insert into public.entity_changes
        (org_id, profile_id, entity_type, amazon_id, entity_name, field, old_value, new_value, source)
      values (${orgA}, ${profileA}, 'campaign', 'c-1', 'Marker campaign', 'budget',
              '10'::jsonb, '15'::jsonb, 'sync')
    `;

    for (const id of ['kw-ready', 'kw-ambiguous']) {
      await database.sql`
        insert into public.keywords
          (org_id, profile_id, amazon_id, ad_product, name, state, campaign_id,
           ad_group_id, keyword_text, match_type, bid, synced_at)
        values (${orgA}, ${profileA}, ${id}, 'SP', ${id}, 'enabled', 'c-1', 'ag-1',
                ${id}, 'exact', 0.90, now())
      `;
    }
  }, 60_000);

  afterAll(async () => {
    await database?.drop();
  });

  it('unions the sync-detected change with the operator apply, newest first', async () => {
    const entries = await listTimeline(database, { orgId: orgA, profileId: profileA });
    // Two syncs (kw-1 bid + marker budget) and one apply (kw-1 bid).
    expect(entries).toHaveLength(3);
    expect(entries.filter((e) => e.source === 'sync')).toHaveLength(2);
    expect(entries.filter((e) => e.source === 'apply')).toHaveLength(1);

    // The apply entry carries its batch metadata; a sync entry never does.
    const apply = entries.find((e) => e.source === 'apply');
    expect(apply?.batch).not.toBeNull();
    expect(apply?.batch?.lever).toBe('bid-down');
    expect(entries.find((e) => e.source === 'sync')?.batch).toBeNull();

    // Reverse chronological: each entry is no newer than the one before it.
    for (let i = 1; i < entries.length; i += 1) {
      expect(entries[i - 1]!.observedAt.getTime()).toBeGreaterThanOrEqual(
        entries[i]!.observedAt.getTime(),
      );
    }
  });

  it('filters by source, entity type and field', async () => {
    const applyOnly = await listTimeline(database, { orgId: orgA, profileId: profileA, source: 'apply' });
    expect(applyOnly).toHaveLength(1);
    expect(applyOnly.every((e) => e.source === 'apply')).toBe(true);

    const syncOnly = await listTimeline(database, { orgId: orgA, profileId: profileA, source: 'sync' });
    expect(syncOnly).toHaveLength(2);

    const campaigns = await listTimeline(database, {
      orgId: orgA,
      profileId: profileA,
      entityTypes: ['campaign'],
    });
    expect(campaigns).toHaveLength(1);
    expect(campaigns[0]?.entityName).toBe('Marker campaign');

    const bidChanges = await listTimeline(database, { orgId: orgA, profileId: profileA, field: 'bid' });
    expect(bidChanges).toHaveLength(2);
    expect(bidChanges.every((e) => e.field === 'bid')).toBe(true);
  });

  it('filters by date range', async () => {
    const past = await listTimeline(database, {
      orgId: orgA,
      profileId: profileA,
      from: '2000-01-01',
      to: '2000-12-31T23:59:59.999Z',
    });
    expect(past).toHaveLength(0);
  });

  it('returns stable non-overlapping windows when a newer change arrives between reads', async () => {
    const complete = await listTimeline(database, {
      orgId: orgA,
      profileId: profileA,
      limit: 3,
    });
    const first = await listTimeline(database, {
      orgId: orgA,
      profileId: profileA,
      limit: 1,
    });
    expect(first).toHaveLength(1);
    const cursor = first[0];
    if (cursor === undefined) throw new Error('timeline cursor fixture is missing');

    const [inserted] = await database.sql<{ id: string }[]>`
      insert into public.entity_changes
        (org_id, profile_id, entity_type, amazon_id, entity_name, field,
         old_value, new_value, source, observed_at)
      values (${orgA}, ${profileA}, 'campaign', 'c-newer', 'Newer marker', 'budget',
              '15'::jsonb, '16'::jsonb, 'sync', now() + interval '1 day')
      returning id
    `;

    try {
      const second = await listTimeline(database, {
        orgId: orgA,
        profileId: profileA,
        limit: 1,
        before: { observedAt: cursor.observedAtExact, id: cursor.id },
      });

      expect(second).toHaveLength(1);
      expect(first[0]?.id).not.toBe(second[0]?.id);
      expect([first[0]?.id, second[0]?.id]).toEqual(complete.slice(0, 2).map((entry) => entry.id));
    } finally {
      await database.sql`delete from public.entity_changes where id = ${inserted?.id ?? ''}`;
    }
  });

  it('never crosses organisations', async () => {
    // Org B asking for org A's profile: the org predicate wins, not the profile.
    const foreign = await listTimeline(database, { orgId: orgB, profileId: profileA });
    expect(foreign).toHaveLength(0);

    // Org B's own timeline is its fixture rows only — one sync, one apply, no marker.
    const own = await listTimeline(database, { orgId: orgB, profileId: profileB });
    expect(own).toHaveLength(2);
    expect(own.some((e) => e.entityName === 'Marker campaign')).toBe(false);
  });

  it('reports the facets present across both sources', async () => {
    const facets = await listTimelineFacets(database, { orgId: orgA, profileId: profileA });
    expect(facets.entityTypes).toEqual(['campaign', 'keyword']);
    expect(facets.fields).toEqual(['bid', 'budget']);

    // Org B never sees org A's campaign/budget facet values.
    const foreign = await listTimelineFacets(database, { orgId: orgB, profileId: profileB });
    expect(foreign.entityTypes).toEqual(['keyword']);
    expect(foreign.fields).toEqual(['bid']);
  });

  it('links one exact export uniquely and creates an immutable inverse batch', async () => {
    const [batch] = await database.sql<{ id: string }[]>`
      insert into public.apply_batches
        (org_id, profile_id, tag, opt_group, lever, note, status, exported_at,
         artifact_sha256, exported_proposals, reversible_rows, unsupported_rows)
      values (${orgA}, ${profileA}, 'tm-ready-export', 'rank', 'push', 'synthetic',
              'staged', now() - interval '1 hour', ${'a'.repeat(64)}, 1, 1, 0)
      returning id
    `;
    const batchId = batch?.id ?? '';
    await database.sql`
      insert into public.apply_rows
        (batch_id, org_id, profile_id, entity_type, entity_id, entity_name, field,
         old_value, new_value, lever)
      values (${batchId}, ${orgA}, ${profileA}, 'keyword', 'kw-ready', 'Ready keyword',
              'bid', '0.9'::jsonb, '0.71'::jsonb, 'push')
    `;

    await database.sql`
      update public.keywords
         set bid = 0.71, synced_at = now() + interval '1 second'
       where org_id = ${orgA} and profile_id = ${profileA} and amazon_id = 'kw-ready'
    `;
    const written = await recordEntityChanges(database, [{
      orgId: orgA,
      profileId: profileA,
      entityType: 'keyword',
      amazonId: 'kw-ready',
      entityName: 'Ready keyword',
      field: 'bid',
      oldValue: 0.9,
      newValue: 0.71,
      source: 'sync',
    }]);
    expect(written).toBe(1);

    const [link] = await database.sql<{
      apply_batch_id: string | null;
      apply_row_id: string | null;
    }[]>`
      select apply_batch_id, apply_row_id from public.entity_changes
       where org_id = ${orgA} and profile_id = ${profileA} and amazon_id = 'kw-ready'
       order by observed_at desc limit 1
    `;
    expect(link?.apply_batch_id).toBe(batchId);
    expect(link?.apply_row_id).not.toBeNull();

    const preview = await getReversionBatchPreview(database, { orgId: orgA, batchId });
    expect(preview).not.toBeNull();
    expect(preview?.rows).toHaveLength(1);
    expect(preview?.rows[0]).toMatchObject({
      originalValue: 0.9,
      exportedValue: 0.71,
      synchronizedValue: 0.71,
      currentValue: 0.71,
      inverseValue: 0.9,
      state: 'ready',
      exportAllowed: true,
    });
    expect(preview?.exportAllowed).toBe(true);
    expect(preview?.lifecycleStatus).toBe('applied_externally');

    const inverse = await createReversionExport(database, {
      orgId: orgA,
      batchId,
      tag: 'tm-ready-export-revert',
      note: 'Synthetic inverse export',
      actorId: USER_A,
    });
    expect(inverse.rows).toHaveLength(1);
    expect(inverse.rows[0]).toMatchObject({ old: 0.71, new: 0.9 });
    expect(inverse.artifactSha256).toMatch(/^[a-f0-9]{64}$/);

    const [stored] = await database.sql<{
      source_batch_id: string | null;
      reversible_rows: number;
      exported_proposals: number;
    }[]>`
      select source_batch_id, reversible_rows, exported_proposals
        from public.apply_batches
       where org_id = ${orgA} and id = ${inverse.batchId}
    `;
    expect(stored).toEqual({
      source_batch_id: batchId,
      reversible_rows: 1,
      exported_proposals: 1,
    });
    const [audit] = await database.sql<{ count: number }[]>`
      select count(*)::int as count from public.audit_log
       where org_id = ${orgA} and action = 'reversion.exported' and target_id = ${inverse.batchId}
    `;
    expect(audit?.count).toBe(1);

    const afterExport = await getReversionBatchPreview(database, { orgId: orgA, batchId });
    expect(afterExport?.activeReversionBatchId).toBe(inverse.batchId);
    expect(afterExport?.exportAllowed).toBe(false);
    await expect(
      createReversionExport(database, {
        orgId: orgA,
        batchId,
        tag: 'tm-ready-export-second-revert',
        note: 'Synthetic duplicate inverse',
        actorId: USER_A,
      }),
    ).rejects.toThrow('active reversion export');

    await database.sql`
      update public.keywords
         set bid = 0.90, synced_at = now() + interval '2 seconds'
       where org_id = ${orgA} and profile_id = ${profileA} and amazon_id = 'kw-ready'
    `;
    await recordEntityChanges(database, [{
      orgId: orgA,
      profileId: profileA,
      entityType: 'keyword',
      amazonId: 'kw-ready',
      entityName: 'Ready keyword',
      field: 'bid',
      oldValue: 0.71,
      newValue: 0.9,
      source: 'sync',
    }]);

    const verified = await getReversionBatchPreview(database, { orgId: orgA, batchId });
    expect(verified?.lifecycleStatus).toBe('verified_reverted');
    const [lifecycles] = await database.sql<{
      source_status: string;
      inverse_status: string;
      inverse_applied_at: Date | null;
    }[]>`
      select source.status::text as source_status,
             inverse.status::text as inverse_status,
             inverse.applied_at as inverse_applied_at
        from public.apply_batches source
        join public.apply_batches inverse on inverse.source_batch_id = source.id
       where source.id = ${batchId}
    `;
    expect(lifecycles).toMatchObject({
      source_status: 'reverted',
      inverse_status: 'applied',
    });
    expect(lifecycles?.inverse_applied_at).not.toBeNull();
  });

  it('canonicalizes worker budget/default-bid fields and advances only complete batches', async () => {
    const cases = [
      {
        tag: 'tm-campaign-budget-alias',
        entityType: 'campaign',
        entityId: 'c-1',
        applyField: 'budget_amount',
        syncField: 'budgetAmount',
        oldValue: 10,
        newValue: 13.37,
        update: () => database.sql`
          update public.campaigns set budget_amount = 13.37, synced_at = now()
           where org_id = ${orgA} and profile_id = ${profileA} and amazon_id = 'c-1'
        `,
      },
      {
        tag: 'tm-ad-group-bid-alias',
        entityType: 'ad_group',
        entityId: 'ag-1',
        applyField: 'bid',
        syncField: 'defaultBid',
        oldValue: 0.75,
        newValue: 1.17,
        update: () => database.sql`
          update public.ad_groups set default_bid = 1.17, synced_at = now()
           where org_id = ${orgA} and profile_id = ${profileA} and amazon_id = 'ag-1'
        `,
      },
    ] as const;

    for (const testCase of cases) {
      const [batch] = await database.sql<{ id: string }[]>`
        insert into public.apply_batches
          (org_id, profile_id, tag, opt_group, lever, note, status, exported_at,
           artifact_sha256, exported_proposals, reversible_rows, unsupported_rows)
        values (${orgA}, ${profileA}, ${testCase.tag}, 'profit', 'adjust', 'synthetic',
                'staged', now() - interval '1 hour', ${'d'.repeat(64)}, 1, 1, 0)
        returning id
      `;
      const batchId = batch?.id ?? '';
      await database.sql`
        insert into public.apply_rows
          (batch_id, org_id, profile_id, entity_type, entity_id, field, old_value, new_value)
        values (${batchId}, ${orgA}, ${profileA},
                ${testCase.entityType}::public.apply_entity_type, ${testCase.entityId},
                ${testCase.applyField}, ${JSON.stringify(testCase.oldValue)}::jsonb,
                ${JSON.stringify(testCase.newValue)}::jsonb)
      `;
      await testCase.update();
      await recordEntityChanges(database, [{
        orgId: orgA,
        profileId: profileA,
        entityType: testCase.entityType,
        amazonId: testCase.entityId,
        field: testCase.syncField,
        oldValue: testCase.oldValue,
        newValue: testCase.newValue,
        source: 'sync',
      }]);

      const preview = await getReversionBatchPreview(database, { orgId: orgA, batchId });
      expect(preview?.rows).toHaveLength(1);
      expect(preview?.rows[0]).toMatchObject({ state: 'ready', exportAllowed: true });
      expect(preview?.lifecycleStatus).toBe('applied_externally');
    }
  });

  it('reconciles orphaned evidence on retry and permits only one concurrent link', async () => {
    const [batch] = await database.sql<{ id: string }[]>`
      insert into public.apply_batches
        (org_id, profile_id, tag, opt_group, lever, note, status, exported_at,
         artifact_sha256, exported_proposals, reversible_rows, unsupported_rows)
      values (${orgA}, ${profileA}, 'tm-reconcile-retry', 'rank', 'push', 'synthetic',
              'staged', now() - interval '1 hour', ${'e'.repeat(64)}, 1, 1, 0)
      returning id
    `;
    const batchId = batch?.id ?? '';
    await database.sql`
      insert into public.apply_rows
        (batch_id, org_id, profile_id, entity_type, entity_id, field, old_value, new_value)
      values (${batchId}, ${orgA}, ${profileA}, 'keyword', 'kw-ambiguous', 'bid',
              '0.72'::jsonb, '0.74'::jsonb)
    `;
    await database.sql`
      update public.keywords set bid = 0.74, synced_at = now()
       where org_id = ${orgA} and profile_id = ${profileA} and amazon_id = 'kw-ambiguous'
    `;
    await database.sql`
      insert into public.entity_changes
        (org_id, profile_id, entity_type, amazon_id, field, old_value, new_value, source)
      values
        (${orgA}, ${profileA}, 'keyword', 'kw-ambiguous', 'bid', '0.72'::jsonb, '0.74'::jsonb, 'sync'),
        (${orgA}, ${profileA}, 'keyword', 'kw-ambiguous', 'bid', '0.72'::jsonb, '0.74'::jsonb, 'sync')
    `;

    const counts = await reconcileEntityChangeLinks(database, { orgId: orgA, profileId: profileA });
    expect(counts.offered).toBeGreaterThanOrEqual(2);
    const [evidence] = await database.sql<{ linked: number; unlinked: number }[]>`
      select count(*) filter (where apply_row_id is not null)::int as linked,
             count(*) filter (where apply_row_id is null)::int as unlinked
        from public.entity_changes
       where org_id = ${orgA} and profile_id = ${profileA}
         and amazon_id = 'kw-ambiguous' and new_value = '0.74'::jsonb
    `;
    expect(evidence).toEqual({ linked: 1, unlinked: 1 });
    const preview = await getReversionBatchPreview(database, { orgId: orgA, batchId });
    expect(preview?.lifecycleStatus).toBe('applied_externally');

    const retry = await reconcileEntityChangeLinks(database, { orgId: orgA, profileId: profileA });
    expect(retry.linked).toBe(0);
  });

  it('keeps repeated same-value exports ambiguous and blocks both inverses', async () => {
    const batches: string[] = [];
    for (const tag of ['tm-duplicate-a', 'tm-duplicate-b']) {
      const [batch] = await database.sql<{ id: string }[]>`
        insert into public.apply_batches
          (org_id, profile_id, tag, opt_group, lever, note, status, exported_at,
           artifact_sha256, exported_proposals, reversible_rows, unsupported_rows)
        values (${orgA}, ${profileA}, ${tag}, 'rank', 'push', 'synthetic', 'staged',
                now() - interval '1 hour', ${'b'.repeat(64)}, 1, 1, 0)
        returning id
      `;
      const batchId = batch?.id ?? '';
      batches.push(batchId);
      await database.sql`
        insert into public.apply_rows
          (batch_id, org_id, profile_id, entity_type, entity_id, field, old_value, new_value)
        values (${batchId}, ${orgA}, ${profileA}, 'keyword', 'kw-ambiguous', 'bid',
                '0.9'::jsonb, '0.72'::jsonb)
      `;
    }

    await recordEntityChanges(database, [{
      orgId: orgA,
      profileId: profileA,
      entityType: 'keyword',
      amazonId: 'kw-ambiguous',
      field: 'bid',
      oldValue: 0.9,
      newValue: 0.72,
      source: 'sync',
    }]);
    await database.sql`
      update public.keywords set bid = 0.72, synced_at = now() + interval '1 second'
       where org_id = ${orgA} and profile_id = ${profileA} and amazon_id = 'kw-ambiguous'
    `;

    const [change] = await database.sql<{ apply_batch_id: string | null }[]>`
      select apply_batch_id from public.entity_changes
       where org_id = ${orgA} and profile_id = ${profileA} and amazon_id = 'kw-ambiguous'
       order by observed_at desc limit 1
    `;
    expect(change?.apply_batch_id).toBeNull();
    for (const batchId of batches) {
      const preview = await getReversionBatchPreview(database, { orgId: orgA, batchId });
      expect(preview?.rows[0]?.state).toBe('ambiguous');
      expect(preview?.exportAllowed).toBe(false);
    }
  });

  it('blocks legacy, mixed-create, conflicted, and cross-tenant batches explicitly', async () => {
    const summaries = await listReversionBatches(database, { orgId: orgA, profileId: profileA });
    const legacy = summaries.find((summary) => summary.tag.includes('2026W33'));
    expect(legacy).toBeDefined();
    const legacyPreview = await getReversionBatchPreview(database, {
      orgId: orgA,
      batchId: legacy?.batchId ?? '',
    });
    expect(legacyPreview?.exportAllowed).toBe(false);
    expect(legacyPreview?.reason).toContain('legacy export');

    const [mixed] = await database.sql<{ id: string }[]>`
      insert into public.apply_batches
        (org_id, profile_id, tag, opt_group, lever, note, artifact_sha256,
         exported_proposals, reversible_rows, unsupported_rows)
      values (${orgA}, ${profileA}, 'tm-mixed-create', 'profit', 'negative', 'synthetic',
              ${'c'.repeat(64)}, 2, 1, 1)
      returning id
    `;
    await database.sql`
      insert into public.apply_rows
        (batch_id, org_id, profile_id, entity_type, entity_id, field, old_value, new_value)
      values (${mixed?.id ?? ''}, ${orgA}, ${profileA}, 'keyword', 'kw-ready', 'bid',
              '0.71'::jsonb, '0.73'::jsonb)
    `;
    const mixedPreview = await getReversionBatchPreview(database, {
      orgId: orgA,
      batchId: mixed?.id ?? '',
    });
    expect(mixedPreview?.unsupportedRows).toBe(1);
    expect(mixedPreview?.exportAllowed).toBe(false);
    expect(mixedPreview?.reason).toContain('create rows');

    const foreign = await getReversionBatchPreview(database, {
      orgId: orgB,
      batchId: mixed?.id ?? '',
    });
    expect(foreign).toBeNull();

    await expect(
      database.sql`
        insert into public.apply_rows
          (batch_id, org_id, profile_id, entity_type, entity_id, field, old_value, new_value)
        values (${mixed?.id ?? ''}, ${orgA}, ${profileB}, 'keyword', 'kw-1', 'bid',
                '0.9'::jsonb, '0.8'::jsonb)
      `,
    ).rejects.toThrow();
  });
});
