/** WP-61 export-time drift and immutable artifact checks. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, databaseAvailable } from '../testing/harness.js';
import type { TestDatabase } from '../testing/harness.js';
import { exportAcceptedRecommendations } from './recommendations.js';

const available = await databaseAvailable();
const USER = '73737373-7373-4373-8373-737373737373';

describe.skipIf(!available)('WP-61 recommendation export snapshot', () => {
  let database: TestDatabase;
  let orgId: string;
  let profileId: string;
  let runId: string;
  let safeRecommendationId: string;
  let staleRecommendationId: string;

  beforeAll(async () => {
    database = await createTestDatabase('wp61_export_snapshot');
    const [tenant] = await database.sql<{ seed_tenant_fixture: string }[]>`
      select app.seed_tenant_fixture('tm-export-snapshot', ${USER}, 'owner')
    `;
    orgId = tenant?.seed_tenant_fixture ?? '';
    const [profile] = await database.sql<{ id: string }[]>`
      select id from public.ad_profiles where org_id = ${orgId} limit 1
    `;
    profileId = profile?.id ?? '';
    const [run] = await database.sql<{ id: string }[]>`
      select id from public.recommendation_runs where org_id = ${orgId} limit 1
    `;
    runId = run?.id ?? '';
    const [safe] = await database.sql<{ id: string }[]>`
      update public.recommendations set status = 'accepted'
       where org_id = ${orgId} and run_id = ${runId}
       returning id
    `;
    safeRecommendationId = safe?.id ?? '';
    const [stale] = await database.sql<{ id: string }[]>`
      insert into public.recommendations
        (run_id, org_id, profile_id, reason, entity_type, entity_id, entity_name,
         field, current_value, proposed_value, inputs, status)
      values (${runId}, ${orgId}, ${profileId}, 'low_acos', 'keyword', 'kw-1',
              'widget', 'bid', '0.9'::jsonb, '0.8'::jsonb, '{}'::jsonb, 'accepted')
      returning id
    `;
    staleRecommendationId = stale?.id ?? '';
  }, 60_000);

  afterAll(async () => {
    await database?.drop();
  });

  it('records a current, counted, fingerprinted export snapshot', async () => {
    const result = await exportAcceptedRecommendations(database, {
      orgId,
      profileId,
      runId,
      ids: [safeRecommendationId],
      tag: 'tm-safe-export',
      optGroup: 'rank',
      lever: 'bid-down',
      note: 'Synthetic safe export',
      actorId: USER,
    });
    expect(result.exported).toBe(1);
    expect(result.rows).toHaveLength(1);

    const [batch] = await database.sql<{
      artifact_sha256: string | null;
      exported_proposals: number;
      reversible_rows: number;
      unsupported_rows: number;
    }[]>`
      select artifact_sha256, exported_proposals, reversible_rows, unsupported_rows
        from public.apply_batches
       where org_id = ${orgId} and id = ${result.batchId}
    `;
    expect(batch?.artifact_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(batch).toMatchObject({ exported_proposals: 1, reversible_rows: 1, unsupported_rows: 0 });

    const [row] = await database.sql<{ profile_id: string; recommendation_id: string | null }[]>`
      select profile_id, recommendation_id from public.apply_rows
       where org_id = ${orgId} and batch_id = ${result.batchId}
    `;
    expect(row).toEqual({ profile_id: profileId, recommendation_id: safeRecommendationId });
  });

  it('blocks an export when the synchronized mirror drifted after calculation', async () => {
    await database.sql`
      update public.keywords set bid = 1.10, synced_at = now()
       where org_id = ${orgId} and profile_id = ${profileId} and amazon_id = 'kw-1'
    `;
    await expect(
      exportAcceptedRecommendations(database, {
        orgId,
        profileId,
        runId,
        ids: [staleRecommendationId],
        tag: 'tm-stale-export',
        optGroup: 'rank',
        lever: 'bid-down',
        note: 'Synthetic stale export',
        actorId: USER,
      }),
    ).rejects.toThrow('synchronized value changed');

    const [counts] = await database.sql<{ batches: number; rows: number }[]>`
      select
        (select count(*)::int from public.apply_batches where org_id = ${orgId} and tag = 'tm-stale-export') as batches,
        (select count(*)::int from public.apply_rows ar join public.apply_batches ab on ab.id = ar.batch_id
          where ab.org_id = ${orgId} and ab.tag = 'tm-stale-export') as rows
    `;
    expect(counts).toEqual({ batches: 0, rows: 0 });
  });
});
