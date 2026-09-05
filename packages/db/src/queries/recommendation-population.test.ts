import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, databaseAvailable, type TestDatabase } from '../testing/harness.js';
import { getExportBatch, listRecommendations, listRecommendationWindow } from './recommendations.js';

const available = await databaseAvailable();
const OWNER = '73737373-7373-4373-8373-737373737373';
describe.skipIf(!available)('counted recommendation windows', () => {
  let database: TestDatabase;
  let orgId: string;
  let profileId: string;
  let runId: string;
  beforeAll(async () => {
    database = await createTestDatabase('recommendation_population');
    const [tenant] = await database.sql<{ id: string }[]>`select app.seed_tenant_fixture('population-fixture', ${OWNER}, 'owner') as id`;
    orgId = tenant!.id;
    const [profile] = await database.sql<{ id: string }[]>`select id from public.ad_profiles where org_id = ${orgId}`;
    profileId = profile!.id;
    const [run] = await database.sql<{ id: string }[]>`insert into public.recommendation_runs
      (org_id, profile_id, status, lookback_days) values (${orgId}, ${profileId}, 'succeeded', 7) returning id`;
    runId = run!.id;
    const offered = 5;
    const rows = await database.sql`insert into public.recommendations
      (org_id, profile_id, run_id, reason, entity_type, entity_id, field, current_value, proposed_value, inputs, status)
      select ${orgId}, ${profileId}, ${runId}, 'high_acos', 'keyword', 'population-' || series::text,
        'bid', '0.9'::jsonb, '0.7'::jsonb, '{}'::jsonb,
        case when series < 4 then 'proposed' else 'accepted' end::public.recommendation_status
      from generate_series(1, ${offered}::int) series returning id`;
    expect(rows).toHaveLength(offered);
  }, 60_000);
  afterAll(async () => { await database?.drop(); });

  it('counts the exact filtered population before the cap, including empty and foreign scopes', async () => {
    const scope = { orgId, profileId, runId, limit: 2 };
    const window = await listRecommendationWindow(database, scope);
    expect(window.population).toEqual({ loaded: 2, total: 5, limit: 2, truncated: true });
    expect(window.rows).toHaveLength(2);
    expect(await listRecommendations(database, scope)).toEqual(window.rows);
    const accepted = await listRecommendationWindow(database, { ...scope, statuses: ['accepted'] });
    expect(accepted.population).toEqual({ loaded: 2, total: 2, limit: 2, truncated: false });
    expect(accepted.rows.every((row) => row.status === 'accepted')).toBe(true);
    for (const patch of [{ orgId: randomUUID() }, { profileId: randomUUID() }, { reasons: ['pacing'] }]) {
      expect(await listRecommendationWindow(database, { ...scope, ...patch }))
        .toEqual({ rows: [], population: { loaded: 0, total: 0, limit: 2, truncated: false } });
    }
  });

  it('refuses invalid limits before they can imply a complete empty result', async () => {
    for (const limit of [0, -1, 1.5, 20_001, NaN, Infinity]) {
      await expect(listRecommendationWindow(database, { orgId, runId, limit })).rejects.toThrow();
    }
  });

  it('refuses an oversized export download instead of dropping its remaining proposals', async () => {
    const [batch] = await database.sql<{ id: string }[]>`insert into public.apply_batches
      (org_id, profile_id, tag, opt_group, lever, note)
      values (${orgId}, ${profileId}, 'synthetic-population-export', 'synthetic', 'bid-down', 'Synthetic population') returning id`;
    const count = 20_001;
    const inserted = await database.sql`insert into public.recommendations
      (org_id, profile_id, run_id, reason, entity_type, entity_id, field, current_value, proposed_value, inputs, status, export_batch_id)
      select ${orgId}, ${profileId}, ${runId}, 'flag', 'negative', 'export-' || series::text,
        'state', 'null'::jsonb, '"enabled"'::jsonb, '{}'::jsonb, 'exported', ${batch!.id}
      from generate_series(1, ${count}::int) series returning id`;
    expect(inserted).toHaveLength(count);
    const window = await listRecommendationWindow(database, { orgId, exportBatchId: batch!.id });
    expect(window.population).toEqual({ loaded: count - 1, total: count, limit: count - 1, truncated: true });
    await expect(getExportBatch(database, { orgId, batchId: batch!.id })).rejects.toThrow('partial artifact cannot be returned');
  });
});
