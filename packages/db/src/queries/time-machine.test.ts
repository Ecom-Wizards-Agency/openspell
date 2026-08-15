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
import { listTimeline, listTimelineFacets } from './time-machine.js';

const available = await databaseAvailable();
const USER_A = '71717171-7171-4171-8171-717171717171';
const USER_B = '72727272-7272-4272-8272-727272727272';

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
});
