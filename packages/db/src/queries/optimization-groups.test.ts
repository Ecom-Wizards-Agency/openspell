import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, databaseAvailable } from '../testing/harness.js';
import type { TestDatabase } from '../testing/harness.js';
import {
  readOptimizationWorkspace,
  saveOptimizationGroup,
  type OptimizationGroupSettings,
} from './optimization-groups.js';

const available = await databaseAvailable();
const USER_A = '69696969-6969-4969-8969-696969696969';
const USER_B = '70707070-7070-4070-8070-707070707070';

const settings: OptimizationGroupSettings = {
  name: 'Rank focus',
  role: 'rank',
  targetAcos: 0.23,
  bidFloor: 0.41,
  bidCeiling: 2.37,
  bidIncreaseCap: 0.17,
  bidDecreaseCap: 0.13,
  placementIncreaseCap: 0.19,
  placementDecreaseCap: 0.11,
  exclusions: ['paused launch'],
  cadence: '7 days',
  prioritization: 'growth_first',
  enabled: true,
};

describe.skipIf(!available)('optimization-group workspace', () => {
  let database: TestDatabase;
  let orgA: string;
  let orgB: string;
  let profileA: string;
  let profileB: string;

  beforeAll(async () => {
    database = await createTestDatabase('wp69_optimization_groups');
    const [a] = await database.sql<{ seed_tenant_fixture: string }[]>`
      select app.seed_tenant_fixture('optimization-alpha', ${USER_A}, 'owner')
    `;
    const [b] = await database.sql<{ seed_tenant_fixture: string }[]>`
      select app.seed_tenant_fixture('optimization-bravo', ${USER_B}, 'owner')
    `;
    orgA = a?.seed_tenant_fixture ?? '';
    orgB = b?.seed_tenant_fixture ?? '';
    const [aProfile] = await database.sql<{ id: string }[]>`
      select id from public.ad_profiles where org_id = ${orgA} limit 1
    `;
    const [bProfile] = await database.sql<{ id: string }[]>`
      select id from public.ad_profiles where org_id = ${orgB} limit 1
    `;
    profileA = aProfile?.id ?? '';
    profileB = bProfile?.id ?? '';
    await database.sql`
      insert into public.campaigns
        (org_id, profile_id, amazon_id, ad_product, name, state, budget_amount, budget_type)
      values (${orgA}, ${profileA}, 'c-2', 'SB', 'second campaign', 'enabled', 20, 'daily')
    `;
  }, 60_000);

  afterAll(async () => {
    await database?.drop();
  });

  it('atomically saves settings and moves the exact campaign set', async () => {
    const first = await saveOptimizationGroup(database, {
      orgId: orgA,
      profileId: profileA,
      actorId: USER_A,
      settings: { ...settings, name: 'Discovery pool', role: 'discovery' },
      campaignIds: ['c-2'],
    });
    expect(first).toMatchObject({
      offeredCampaigns: 1,
      assignedCampaigns: 1,
      movedCampaigns: 0,
      removedCampaigns: 0,
    });

    const workspace = await readOptimizationWorkspace(database, { orgId: orgA, profileId: profileA });
    const fixture = workspace.groups.find((record) => record.group.name === 'Fixture Group');
    expect(fixture).not.toBeUndefined();

    const updated = await saveOptimizationGroup(database, {
      orgId: orgA,
      profileId: profileA,
      actorId: USER_A,
      id: fixture?.group.id,
      settings,
      campaignIds: ['c-2', 'c-1'],
    });
    expect(updated).toMatchObject({
      offeredCampaigns: 2,
      assignedCampaigns: 2,
      movedCampaigns: 1,
      removedCampaigns: 0,
    });
    expect(updated.record.group).toEqual(expect.objectContaining({
      name: 'Rank focus',
      role: 'rank',
      targetAcos: 0.23,
      cadence: '7 days',
      prioritization: 'growth_first',
    }));
    expect(updated.record.campaignIds).toEqual(['c-1', 'c-2']);

    const after = await readOptimizationWorkspace(database, { orgId: orgA, profileId: profileA });
    expect(after).toMatchObject({ assignedCampaigns: 2, unassignedCampaigns: 0 });
    expect(
      after.groups.find((record) => record.group.id === first.record.group.id)?.campaignIds,
    ).toEqual([]);
    const [audit] = await database.sql<{ campaigns: number; moved: number }[]>`
      select (payload->>'campaigns')::int as campaigns,
             (payload->>'movedCampaigns')::int as moved
        from public.audit_log
       where org_id = ${orgA}
         and action = 'optimization_group.saved'
         and target_id = ${fixture?.group.id ?? ''}
       order by id desc limit 1
    `;
    expect(audit).toEqual({ campaigns: 2, moved: 1 });
  });

  it('rolls back settings and assignments when any campaign is outside the profile', async () => {
    const before = await readOptimizationWorkspace(database, { orgId: orgA, profileId: profileA });
    const group = before.groups.find((record) => record.group.name === 'Rank focus');
    expect(group).not.toBeUndefined();

    await expect(
      saveOptimizationGroup(database, {
        orgId: orgA,
        profileId: profileA,
        actorId: USER_A,
        id: group?.group.id,
        settings: { ...settings, name: 'Must roll back' },
        campaignIds: ['c-1', 'foreign-campaign'],
      }),
    ).rejects.toThrow('offered 2 campaigns but found 1');

    const after = await readOptimizationWorkspace(database, { orgId: orgA, profileId: profileA });
    const unchanged = after.groups.find((record) => record.group.id === group?.group.id);
    expect(unchanged?.group.name).toBe('Rank focus');
    expect(unchanged?.campaignIds).toEqual(['c-1', 'c-2']);
  });

  it('never reads or accepts another tenant profile', async () => {
    const own = await readOptimizationWorkspace(database, { orgId: orgA, profileId: profileA });
    const other = await readOptimizationWorkspace(database, { orgId: orgA, profileId: profileB });
    expect(own.groups.length).toBeGreaterThan(0);
    expect(other).toEqual({ groups: [], campaigns: [], assignedCampaigns: 0, unassignedCampaigns: 0 });

    await expect(
      saveOptimizationGroup(database, {
        orgId: orgA,
        profileId: profileB,
        actorId: USER_A,
        settings,
        campaignIds: [],
      }),
    ).rejects.toThrow('profile not found in organisation');

    const [otherCount] = await database.sql<{ count: number }[]>`
      select count(*)::int as count from public.optimization_groups where org_id = ${orgB}
    `;
    expect(otherCount?.count).toBe(1);
  });
});
