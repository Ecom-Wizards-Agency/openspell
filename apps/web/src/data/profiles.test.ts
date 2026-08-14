/**
 * The roster reads and the two writes, against the real schema.
 *
 * The filters are tested by counting, because "the SQL runs" and "the SQL
 * filters" look identical from the outside until a row that should have been
 * excluded turns up in front of a client. The writes are tested for what they
 * changed *and* for what they left alone: a targets edit that quietly resets
 * `sync_enabled` would be a cost incident, not a UI bug.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, databaseAvailable } from '@wizard-ads/db/testing';
import type { TestDatabase } from '@wizard-ads/db/testing';
import { loadRoster, setProfileSyncEnabled, updateProfileTargets } from './profiles';

const available = await databaseAvailable();
const OWNER = '77777777-7777-4777-8777-777777777777';
const OTHER = '88888888-8888-4888-8888-888888888888';

describe.skipIf(!available)('roster', () => {
  let database: TestDatabase;
  let orgId: string;
  let otherOrgId: string;

  beforeAll(async () => {
    database = await createTestDatabase('webroster');
    const [org] = await database.sql<{ seed_tenant_fixture: string }[]>`
      select app.seed_tenant_fixture('webroster', ${OWNER}, 'owner')
    `;
    orgId = org?.seed_tenant_fixture ?? '';
    const [other] = await database.sql<{ seed_tenant_fixture: string }[]>`
      select app.seed_tenant_fixture('webroster-other', ${OTHER}, 'owner')
    `;
    otherOrgId = other?.seed_tenant_fixture ?? '';

    const [connection] = await database.sql<{ id: string }[]>`
      select id from public.ads_connections where org_id = ${orgId} limit 1
    `;

    // A small, synthetic roster: two regions, three countries, one already on.
    const rows = [
      { id: 'p-na-1', region: 'NA', country: 'US', name: 'Alpha storefront', sync: true },
      { id: 'p-na-2', region: 'NA', country: 'CA', name: 'Beta storefront', sync: false },
      { id: 'p-eu-1', region: 'EU', country: 'DE', name: 'Gamma storefront', sync: false },
      { id: 'p-eu-2', region: 'EU', country: 'DE', name: 'Delta storefront', sync: false },
    ];
    for (const row of rows) {
      await database.sql`
        insert into public.ad_profiles
          (org_id, connection_id, amazon_profile_id, region, country_code, currency_code,
           timezone, account_name, sync_enabled)
        values (${orgId}, ${connection?.id ?? null}, ${row.id}, ${row.region}::public.ads_region,
                ${row.country}, ${row.region === 'NA' ? 'USD' : 'EUR'}, 'UTC', ${row.name},
                ${row.sync})
      `;
    }
  }, 120_000);

  afterAll(async () => {
    await database?.drop();
  });

  it('counts every profile in the org, filtered or not', async () => {
    const all = await loadRoster(database, orgId);
    // Four inserted here plus the one the tenant fixture seeds.
    expect(all.total).toBe(5);
    expect(all.rows).toHaveLength(all.total);
    expect(all.regionCounts).toEqual({ NA: 3, EU: 2 });
    expect(all.countries).toEqual(['CA', 'DE', 'US']);
  });

  it('filters by region, country, sync state and free text', async () => {
    expect((await loadRoster(database, orgId, { region: 'EU' })).rows).toHaveLength(2);
    expect((await loadRoster(database, orgId, { country: 'DE' })).rows).toHaveLength(2);
    expect((await loadRoster(database, orgId, { syncEnabled: true })).rows).toHaveLength(2);
    expect((await loadRoster(database, orgId, { search: 'gamma' })).rows).toHaveLength(1);
    expect((await loadRoster(database, orgId, { search: 'p-na-' })).rows).toHaveLength(2);
    expect(
      (await loadRoster(database, orgId, { region: 'EU', country: 'US' })).rows,
    ).toHaveLength(0);
  });

  it('never shows another org a profile', async () => {
    const mine = await loadRoster(database, orgId, { search: 'p-na-1' });
    const theirs = await loadRoster(database, otherOrgId, { search: 'p-na-1' });
    expect(mine.rows).toHaveLength(1);
    expect(theirs.rows).toHaveLength(0);
  });

  it('saves targets without touching the sync gate', async () => {
    const before = await loadRoster(database, orgId, { search: 'p-na-1' });
    const profile = before.rows[0];
    expect(profile).toBeDefined();
    if (!profile) return;
    expect(profile.syncEnabled).toBe(true);

    const saved = await updateProfileTargets(database, orgId, profile.id, {
      targetAcos: 0.245,
      targetTotalAcos: 0.18,
      goalLens: 'scale',
      monthlyBudget: 4200.5,
    });

    expect(saved.targetAcos).toBeCloseTo(0.245, 4);
    expect(saved.targetTotalAcos).toBeCloseTo(0.18, 4);
    expect(saved.goalLens).toBe('scale');
    expect(saved.monthlyBudget).toBeCloseTo(4200.5, 2);
    expect(saved.syncEnabled).toBe(true);
  });

  it('clears a target when it is set to null', async () => {
    const [profile] = (await loadRoster(database, orgId, { search: 'p-na-1' })).rows;
    if (!profile) throw new Error('fixture missing');
    const cleared = await updateProfileTargets(database, orgId, profile.id, {
      targetAcos: null,
      targetTotalAcos: null,
      goalLens: null,
      monthlyBudget: null,
    });
    expect(cleared.targetAcos).toBeNull();
    expect(cleared.targetTotalAcos).toBeNull();
  });

  it('toggles sync without touching targets', async () => {
    const [profile] = (await loadRoster(database, orgId, { search: 'p-eu-1' })).rows;
    if (!profile) throw new Error('fixture missing');
    await updateProfileTargets(database, orgId, profile.id, {
      targetAcos: 0.3,
      targetTotalAcos: null,
      goalLens: 'defend',
      monthlyBudget: null,
    });

    const on = await setProfileSyncEnabled(database, orgId, profile.id, true);
    expect(on.syncEnabled).toBe(true);
    expect(on.targetAcos).toBeCloseTo(0.3, 4);
    expect(on.goalLens).toBe('defend');

    const off = await setProfileSyncEnabled(database, orgId, profile.id, false);
    expect(off.syncEnabled).toBe(false);
  });

  it('refuses a write scoped to the wrong org', async () => {
    const [profile] = (await loadRoster(database, orgId, { search: 'p-eu-2' })).rows;
    if (!profile) throw new Error('fixture missing');

    await expect(
      setProfileSyncEnabled(database, otherOrgId, profile.id, true),
    ).rejects.toThrow(/no profile/);
    await expect(
      updateProfileTargets(database, otherOrgId, profile.id, {
        targetAcos: 0.9,
        targetTotalAcos: null,
        goalLens: null,
        monthlyBudget: null,
      }),
    ).rejects.toThrow(/no profile/);

    const [row] = await database.sql<{ sync_enabled: boolean; target_acos: string | null }[]>`
      select sync_enabled, target_acos from public.ad_profiles where id = ${profile.id}
    `;
    expect(row?.sync_enabled).toBe(false);
    expect(row?.target_acos).toBeNull();
  });
});
