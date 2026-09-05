/**
 * HTTP-boundary proof for tenant-scoped, role-gated optimizer previews.
 *
 * The database carries every migration (the same 46 files `supabase db reset`
 * applies) and starts in the `20260901060000` authority's default legacy mode,
 * which is the hosted state until the fenced cutover runs. Each test states the
 * authority it needs rather than inheriting it, because the routes must read
 * fresh evidence on every request and the two modes are decided by that
 * evidence together with the deployment flag.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, databaseAvailable, migrationFiles } from '@wizard-ads/db/testing';
import type { TestDatabase } from '@wizard-ads/db/testing';
import {
  PostgresRecommendationRunStore,
  PostgresWorkerStore,
  SyncWorker,
  createRecommendationsRunner,
} from '@wizard-ads/worker';
import { POST } from '../app/api/optimizer/runs/route.js';
import { GET } from '../app/api/optimizer/runs/[batchId]/route.js';
import { POST as POST_GROUP } from '../app/api/optimizer/groups/run/route.js';
import { cronSyncJobTypesFromEnv } from './server/sync-tick.js';

const available = await databaseAvailable();
const OWNER_A = '71717171-7171-4717-8171-717171717171';
const VIEWER_A = '72727272-7272-4727-8272-727272727272';
const OWNER_B = '73737373-7373-4737-8373-737373737373';
const BRIDGE_SECRET = 'synthetic-optimizer-route-bridge-secret';
const RECOMMENDATION_REVISION = 'c'.repeat(40);
const UNAVAILABLE = 'Recommendation previews are temporarily unavailable.';

type Authority = Readonly<{
  protocol: 'legacy' | 'fenced';
  admission: 'legacy' | 'blocked' | 'scoped';
  revision: string | null;
}>;
const LEGACY: Authority = { protocol: 'legacy', admission: 'legacy', revision: null };
const LEGACY_BLOCKED: Authority = { protocol: 'legacy', admission: 'blocked', revision: null };
const FENCED_SCOPED: Authority = {
  protocol: 'fenced', admission: 'scoped', revision: RECOMMENDATION_REVISION,
};

interface ArtifactCounts {
  batches: number;
  runs: number;
  scopes: number;
  jobs: number;
}

describe.skipIf(!available)('optimizer preview routes', () => {
  let database: TestDatabase;
  let orgA: string;
  let orgB: string;
  let profileA: string;
  let profileB: string;
  let groupB: string;
  let foreignBatchId: string;
  let acceptedBatchId: string;
  const previous = {
    databaseUrl: process.env['DATABASE_URL'],
    bridgeSecret: process.env['WIZARD_ADS_AUTH_BRIDGE_SECRET'],
    bridgeEnabled: process.env['WIZARD_ADS_E2E_AUTH_BRIDGE'],
    recommendationReady: process.env['OPENSPELL_RECOMMENDATION_LANE_READY'],
    recommendationRevision: process.env['OPENSPELL_RECOMMENDATION_LANE_REVISION'],
  };

  const headers = (userId: string, orgId: string, bridge = BRIDGE_SECRET) => ({
    'content-type': 'application/json',
    'x-wizard-ads-auth-bridge': bridge,
    'x-wizard-ads-user-id': userId,
    'x-wizard-ads-org-id': orgId,
  });
  const params = (batchId: string) => ({ params: Promise.resolve({ batchId }) });
  const previewRequest = (userId: string, orgId: string, profileId: string): Request =>
    new Request('http://localhost/api/optimizer/runs', {
      method: 'POST',
      headers: headers(userId, orgId),
      body: JSON.stringify({
        profileId,
        clientRequestId: crypto.randomUUID(),
        scope: { mode: 'selected', campaignIds: ['c-1'] },
      }),
    });
  const groupRequest = (): Request => new Request('http://localhost/api/optimizer/groups/run', {
    method: 'POST',
    headers: headers(OWNER_B, orgB),
    body: JSON.stringify({ profileId: profileB, groupId: groupB }),
  });

  function laneEnv(ready: string | undefined, revision: string | undefined): void {
    if (ready === undefined) delete process.env['OPENSPELL_RECOMMENDATION_LANE_READY'];
    else process.env['OPENSPELL_RECOMMENDATION_LANE_READY'] = ready;
    if (revision === undefined) delete process.env['OPENSPELL_RECOMMENDATION_LANE_REVISION'];
    else process.env['OPENSPELL_RECOMMENDATION_LANE_REVISION'] = revision;
  }

  async function setAuthority(authority: Authority): Promise<void> {
    // The suite exercises the web boundary, not the separately proven cutover
    // transition, so the disposable singleton is written directly.
    await database.sql`
      update app.recommendation_claim_authority
         set protocol = ${authority.protocol}, admission = ${authority.admission},
             authorized_revision = ${authority.revision}, epoch = epoch + 1, updated_at = now()
       where singleton
    `;
  }

  async function artifacts(orgId: string): Promise<ArtifactCounts> {
    const [row] = await database.sql<ArtifactCounts[]>`
      select
        (select count(*)::integer from public.recommendation_preview_batches where org_id = ${orgId}) as batches,
        (select count(*)::integer from public.recommendation_runs where org_id = ${orgId}) as runs,
        (select count(*)::integer
           from public.recommendation_run_campaigns scope
           join public.recommendation_runs run on run.id = scope.run_id
          where run.org_id = ${orgId}) as scopes,
        (select count(*)::integer from public.sync_jobs
          where org_id = ${orgId} and job_type = 'recommendations.run') as jobs
    `;
    if (row === undefined) throw new Error('artifact count query returned no row');
    return row;
  }

  /** The Vercel cron claimant as deployed in legacy mode: same job set, same legacy claims. */
  async function drainAsLegacyCron(): Promise<number> {
    const jobTypes = cronSyncJobTypesFromEnv({});
    expect(jobTypes).toContain('recommendations.run');
    const runs = new PostgresRecommendationRunStore(database);
    const worker = new SyncWorker({
      workerId: 'vercel-cron-legacy-test',
      store: new PostgresWorkerStore(database, { info: () => {} }),
      jobTypes,
      recommendationsRun: createRecommendationsRunner(runs),
      logger: { info: () => {}, error: () => {} },
    });
    return worker.drainOnce();
  }

  async function expectCountedLegacyRun(runId: string, jobId: string): Promise<void> {
    const [job] = await database.sql<{
      status: string;
      claimed_by: string | null;
      claim_token: string | null;
      result: { runId?: string; proposals?: number } | null;
    }[]>`
      select status::text as status, claimed_by, claim_token, result
        from public.sync_jobs where id = ${jobId}
    `;
    const [run] = await database.sql<{ status: string; proposals_count: number }[]>`
      select status::text as status, proposals_count
        from public.recommendation_runs where id = ${runId}
    `;
    const [proposals] = await database.sql<{ count: number }[]>`
      select count(*)::integer as count from public.recommendations where run_id = ${runId}
    `;
    expect(job).toMatchObject({
      status: 'succeeded',
      claimed_by: 'vercel-cron-legacy-test',
      // Legacy claims are token-less by definition; a token would mean fenced custody.
      claim_token: null,
    });
    expect(run?.status).toBe('succeeded');
    expect(job?.result?.runId).toBe(runId);
    expect(job?.result?.proposals).toBe(proposals?.count);
    expect(run?.proposals_count).toBe(proposals?.count);
  }

  beforeAll(async () => {
    database = await createTestDatabase('wp216_web_routes');
    // The harness applies every migration; this regression requires custody
    // admission to exist even when later additive write migrations are present.
    expect(await migrationFiles()).toContain('20260901060000_recommendation_claim_custody.sql');
    const [authority] = await database.sql<{ protocol: string; admission: string }[]>`
      select protocol, admission from public.get_recommendation_claim_authority()
    `;
    expect(authority).toEqual({ protocol: 'legacy', admission: 'legacy' });

    const [tenantA] = await database.sql<{ seed_tenant_fixture: string }[]>`
      select app.seed_tenant_fixture('optimizer-route-alpha', ${OWNER_A}, 'owner')
    `;
    const [tenantB] = await database.sql<{ seed_tenant_fixture: string }[]>`
      select app.seed_tenant_fixture('optimizer-route-bravo', ${OWNER_B}, 'owner')
    `;
    orgA = tenantA?.seed_tenant_fixture ?? '';
    orgB = tenantB?.seed_tenant_fixture ?? '';
    await database.sql`select public.auth_user_stub(${VIEWER_A})`;
    await database.sql`
      insert into public.org_members (org_id, user_id, role)
      values (${orgA}, ${VIEWER_A}, 'viewer')
    `;
    const [a] = await database.sql<{ id: string }[]>`
      select id from public.ad_profiles where org_id = ${orgA}
    `;
    const [b] = await database.sql<{ id: string }[]>`
      select id from public.ad_profiles where org_id = ${orgB}
    `;
    const [foreignBatch] = await database.sql<{ id: string }[]>`
      select id from public.recommendation_preview_batches where org_id = ${orgB}
    `;
    const [group] = await database.sql<{ id: string }[]>`
      select id from public.optimization_groups where org_id = ${orgB} order by created_at limit 1
    `;
    if (!a || !b || !foreignBatch || !group) throw new Error('optimizer route fixture is incomplete');
    profileA = a.id;
    profileB = b.id;
    foreignBatchId = foreignBatch.id;
    groupB = group.id;

    // Keep tenant A's c-1 eligible and unassigned, so group-specific safety
    // state is irrelevant to the batch route. Tenant B keeps its fixture group
    // with c-1 assigned for the group route.
    await database.sql`delete from public.campaign_optimization_assignments where org_id = ${orgA}`;

    process.env['DATABASE_URL'] = database.connectionString;
    process.env['WIZARD_ADS_AUTH_BRIDGE_SECRET'] = BRIDGE_SECRET;
    process.env['WIZARD_ADS_E2E_AUTH_BRIDGE'] = '1';
    laneEnv(undefined, undefined);
  }, 60_000);

  afterAll(async () => {
    if (previous.databaseUrl === undefined) delete process.env['DATABASE_URL'];
    else process.env['DATABASE_URL'] = previous.databaseUrl;
    if (previous.bridgeSecret === undefined) delete process.env['WIZARD_ADS_AUTH_BRIDGE_SECRET'];
    else process.env['WIZARD_ADS_AUTH_BRIDGE_SECRET'] = previous.bridgeSecret;
    if (previous.bridgeEnabled === undefined) delete process.env['WIZARD_ADS_E2E_AUTH_BRIDGE'];
    else process.env['WIZARD_ADS_E2E_AUTH_BRIDGE'] = previous.bridgeEnabled;
    laneEnv(previous.recommendationReady, previous.recommendationRevision);
    await database?.drop();
  });

  it('refuses viewers and untrusted actors before writing preview artifacts', async () => {
    await setAuthority(LEGACY);
    const before = await artifacts(orgA);
    const viewer = await POST(previewRequest(VIEWER_A, orgA, profileA));
    expect(viewer.status).toBe(403);
    const untrusted = await POST(new Request('http://localhost/api/optimizer/runs', {
      method: 'POST',
      headers: headers(OWNER_A, orgA, 'wrong-bridge-secret'),
      body: JSON.stringify({
        profileId: profileA,
        clientRequestId: crypto.randomUUID(),
        scope: { mode: 'selected', campaignIds: ['c-1'] },
      }),
    }));
    expect(untrusted.status).toBe(401);
    expect(await artifacts(orgA)).toEqual(before);
  });

  it('queues exact scoped legacy work with an unset flag, which the legacy cron claimant then runs and counts', async () => {
    await setAuthority(LEGACY);
    laneEnv(undefined, undefined);
    const before = await artifacts(orgA);

    const response = await POST(previewRequest(OWNER_A, orgA, profileA));
    expect(response.status).toBe(202);
    const accepted = await response.json() as {
      batchId: string;
      status: string;
      mode: string;
      scope: { mode: string; campaignCount: number; fingerprint: string };
      childCount: number;
    };
    acceptedBatchId = accepted.batchId;
    expect(accepted).toMatchObject({
      status: 'queued',
      mode: 'legacy',
      scope: { mode: 'selected', campaignCount: 1 },
      childCount: 1,
    });

    // One run, one job, one scope row, created together and linked both ways,
    // with the scope columns the 20260901060000 admission trigger validates.
    const after = await artifacts(orgA);
    expect(after).toEqual({
      batches: before.batches + 1,
      runs: before.runs + 1,
      scopes: before.scopes + 1,
      jobs: before.jobs + 1,
    });
    const [run] = await database.sql<{
      id: string;
      status: string;
      batch_id: string;
      scope_version: number;
      scope_count: number;
      scope_fingerprint: string;
      job_id: string;
      execution_lineage: string;
      group_id: string | null;
    }[]>`
      select id, status::text as status, batch_id, scope_version, scope_count,
             scope_fingerprint, job_id, execution_lineage, group_id
        from public.recommendation_runs
       where org_id = ${orgA} and batch_id = ${accepted.batchId}
    `;
    if (run === undefined) throw new Error('legacy preview run was not created');
    expect(run).toMatchObject({
      status: 'queued',
      batch_id: accepted.batchId,
      scope_version: 1,
      scope_count: 1,
      scope_fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      execution_lineage: 'queue',
      group_id: null,
    });
    const [job] = await database.sql<{
      status: string;
      job_type: string;
      claim_token: string | null;
      payload: { type?: string; runId?: string; orgId?: string; profileId?: string };
    }[]>`
      select status::text as status, job_type::text as job_type, claim_token, payload
        from public.sync_jobs
       where id = ${run.job_id} and org_id = ${orgA} and profile_id = ${profileA}
    `;
    expect(job).toMatchObject({
      status: 'queued',
      job_type: 'recommendations.run',
      claim_token: null,
      payload: { type: 'recommendations.run', runId: run.id, orgId: orgA, profileId: profileA },
    });

    const status = await GET(
      new Request(
        `http://localhost/api/optimizer/runs/${acceptedBatchId}?profileId=${profileA}`,
        { headers: headers(VIEWER_A, orgA) },
      ),
      params(acceptedBatchId),
    );
    expect(status.status).toBe(200);
    await expect(status.json()).resolves.toMatchObject({
      batchId: acceptedBatchId,
      status: 'queued',
      campaignCount: 1,
      children: [{ campaignCount: 1, status: 'queued' }],
    });

    // The deployed legacy claimant is Vercel cron with the legacy claim protocol.
    expect(await drainAsLegacyCron()).toBe(1);
    await expectCountedLegacyRun(run.id, run.job_id);
  });

  it('treats an exact 0 flag the same as unset and queues legacy work for the group route too', async () => {
    await setAuthority(LEGACY);
    laneEnv('0', 'stale-value-is-inert');
    const beforeA = await artifacts(orgA);
    const beforeB = await artifacts(orgB);

    const batch = await POST(previewRequest(OWNER_A, orgA, profileA));
    expect(batch.status).toBe(202);
    await expect(batch.json()).resolves.toMatchObject({ mode: 'legacy', childCount: 1 });

    const group = await POST_GROUP(groupRequest());
    expect(group.status).toBe(202);
    const queued = await group.json() as { runId: string; jobId: string; mode: string };
    expect(queued.mode).toBe('legacy');
    const [groupRun] = await database.sql<{
      job_id: string;
      group_id: string | null;
      scope_version: number;
      scope_count: number;
      execution_lineage: string;
    }[]>`
      select job_id, group_id, scope_version, scope_count, execution_lineage
        from public.recommendation_runs where id = ${queued.runId} and org_id = ${orgB}
    `;
    expect(groupRun).toEqual({
      job_id: queued.jobId,
      group_id: groupB,
      scope_version: 1,
      scope_count: 1,
      execution_lineage: 'queue',
    });

    expect(await artifacts(orgA)).toEqual({
      batches: beforeA.batches + 1, runs: beforeA.runs + 1, scopes: beforeA.scopes + 1, jobs: beforeA.jobs + 1,
    });
    expect(await artifacts(orgB)).toEqual({
      batches: beforeB.batches, runs: beforeB.runs + 1, scopes: beforeB.scopes + 1, jobs: beforeB.jobs + 1,
    });

    // Both tenants' work is claimed by the same legacy claimant and settled.
    expect(await drainAsLegacyCron()).toBe(2);
    await expectCountedLegacyRun(queued.runId, queued.jobId);
  });

  it('fails closed before enqueue on both routes when legacy admission is blocked', async () => {
    await setAuthority(LEGACY_BLOCKED);
    laneEnv(undefined, undefined);
    const beforeA = await artifacts(orgA);
    const beforeB = await artifacts(orgB);
    for (const response of [
      await POST(previewRequest(OWNER_A, orgA, profileA)),
      await POST_GROUP(groupRequest()),
    ]) {
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({
        error: UNAVAILABLE, reason: 'admission_not_legacy',
      });
    }
    expect(await artifacts(orgA)).toEqual(beforeA);
    expect(await artifacts(orgB)).toEqual(beforeB);
  });

  it('fails closed when the flag is reversed after the database has cut over to fenced claims', async () => {
    await setAuthority(FENCED_SCOPED);
    const beforeA = await artifacts(orgA);
    const beforeB = await artifacts(orgB);
    for (const ready of [undefined, '0']) {
      laneEnv(ready, undefined);
      for (const response of [
        await POST(previewRequest(OWNER_A, orgA, profileA)),
        await POST_GROUP(groupRequest()),
      ]) {
        expect(response.status).toBe(503);
        await expect(response.json()).resolves.toEqual({
          error: UNAVAILABLE, reason: 'authority_not_legacy',
        });
      }
    }
    expect(await artifacts(orgA)).toEqual(beforeA);
    expect(await artifacts(orgB)).toEqual(beforeB);
  });

  it('fails closed with zero artifacts when the authority row is unavailable', async () => {
    laneEnv(undefined, undefined);
    const before = await artifacts(orgA);
    const [saved] = await database.sql<{
      protocol: string; admission: string; epoch: string; authorized_revision: string | null;
    }[]>`
      delete from app.recommendation_claim_authority where singleton
      returning protocol, admission, epoch::text as epoch, authorized_revision
    `;
    if (saved === undefined) throw new Error('authority fixture was already missing');
    try {
      const response = await POST(previewRequest(OWNER_A, orgA, profileA));
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({
        error: UNAVAILABLE, reason: 'authority_unavailable',
      });
    } finally {
      await database.sql`
        insert into app.recommendation_claim_authority
          (singleton, protocol, admission, epoch, authorized_revision)
        values (true, ${saved.protocol}, ${saved.admission}, ${saved.epoch}::bigint,
                ${saved.authorized_revision})
      `;
    }
    expect(await artifacts(orgA)).toEqual(before);
  });

  it('queues fenced work only with exact intent and fresh fenced authority, and says so', async () => {
    await setAuthority(FENCED_SCOPED);
    laneEnv('1', RECOMMENDATION_REVISION);
    const before = await artifacts(orgA);
    const response = await POST(previewRequest(OWNER_A, orgA, profileA));
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      status: 'queued',
      mode: 'fenced',
      scope: { mode: 'selected', campaignCount: 1 },
      childCount: 1,
    });
    expect(await artifacts(orgA)).toEqual({
      batches: before.batches + 1, runs: before.runs + 1, scopes: before.scopes + 1, jobs: before.jobs + 1,
    });
  });

  it('keeps the existing fenced refusals and message on both routes', async () => {
    await setAuthority(FENCED_SCOPED);
    const beforeA = await artifacts(orgA);
    const beforeB = await artifacts(orgB);

    laneEnv('1', 'd'.repeat(40));
    const mismatch = await POST_GROUP(groupRequest());
    expect(mismatch.status).toBe(503);
    await expect(mismatch.json()).resolves.toEqual({ error: UNAVAILABLE, reason: 'revision_mismatch' });

    await setAuthority({ ...FENCED_SCOPED, admission: 'blocked' });
    laneEnv('1', RECOMMENDATION_REVISION);
    const blocked = await POST(previewRequest(OWNER_A, orgA, profileA));
    expect(blocked.status).toBe(503);
    await expect(blocked.json()).resolves.toEqual({ error: UNAVAILABLE, reason: 'admission_not_scoped' });

    await setAuthority(LEGACY);
    const notFenced = await POST(previewRequest(OWNER_A, orgA, profileA));
    expect(notFenced.status).toBe(503);
    await expect(notFenced.json()).resolves.toEqual({ error: UNAVAILABLE, reason: 'authority_not_fenced' });

    expect(await artifacts(orgA)).toEqual(beforeA);
    expect(await artifacts(orgB)).toEqual(beforeB);
  });

  it('is 503 misconfigured on both routes for an invalid flag, without consulting the database', async () => {
    await setAuthority(LEGACY);
    const beforeA = await artifacts(orgA);
    const beforeB = await artifacts(orgB);
    for (const [ready, revision] of [
      ['1', undefined],
      ['true', RECOMMENDATION_REVISION],
      ['1', 'a'.repeat(39)],
    ] as const) {
      laneEnv(ready, revision);
      for (const response of [
        await POST(previewRequest(OWNER_A, orgA, profileA)),
        await POST_GROUP(groupRequest()),
      ]) {
        expect(response.status).toBe(503);
        await expect(response.json()).resolves.toEqual({ error: UNAVAILABLE, reason: 'misconfigured' });
      }
    }
    laneEnv(undefined, undefined);
    expect(await artifacts(orgA)).toEqual(beforeA);
    expect(await artifacts(orgB)).toEqual(beforeB);
  });

  it('returns the same 404 for foreign batch and profile combinations', async () => {
    const attempts = [
      GET(
        new Request(
          `http://localhost/api/optimizer/runs/${foreignBatchId}?profileId=${profileA}`,
          { headers: headers(OWNER_A, orgA) },
        ),
        params(foreignBatchId),
      ),
      GET(
        new Request(
          `http://localhost/api/optimizer/runs/${acceptedBatchId}?profileId=${profileB}`,
          { headers: headers(OWNER_B, orgB) },
        ),
        params(acceptedBatchId),
      ),
    ];
    for (const response of await Promise.all(attempts)) {
      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({ error: 'Not found' });
    }
  });

  it('maps malformed status identity to a bounded safe error', async () => {
    const response = await GET(
      new Request(
        `http://localhost/api/optimizer/runs/not-a-uuid?profileId=${profileA}`,
        { headers: headers(OWNER_A, orgA) },
      ),
      params('not-a-uuid'),
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'batchId must be a UUID' });
  });
});
