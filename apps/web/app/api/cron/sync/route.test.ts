/**
 * The cron drain route's gate and its scheduled-producer ownership.
 *
 * The door: an unauthenticated caller must never be able to make this route
 * spend Amazon quota. So these check the three ways in are refused — no
 * configured secret, no header, wrong header — and that a correctly
 * authenticated call gets *past* the gate (proven by it failing later, on the
 * missing database, rather than on auth).
 *
 * The scheduler: this route composes a weekly recommendation producer only for
 * enabled lane intent, then gates it on fenced authority. The manual "Run
 * preview" legacy fallback (WP-216) must not turn that producer on. Those
 * cases swap the database handle and the tick for doubles that record what the
 * route wired, while every other function stays real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DbHandle } from '@wizard-ads/db';
import type { SyncTickDeps, SyncTickResult } from '../../../../src/server/sync-tick';
import { cronSyncJobTypesFromEnv } from '../../../../src/server/sync-tick';
import { GET } from './route';

const doubles = vi.hoisted(() => ({
  authorityRows: [] as unknown[],
  authoritySql: vi.fn(async () => [] as unknown[]),
  begin: vi.fn(async () => { throw new Error('scheduled producer must not open a transaction here'); }),
  closed: 0,
  tickDeps: [] as SyncTickDeps[],
}));

vi.mock('@wizard-ads/db', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    createDb: (): DbHandle => ({
      sql: Object.assign(
        (...args: unknown[]) => doubles.authoritySql(...(args as [])),
        { begin: doubles.begin },
      ) as unknown as DbHandle['sql'],
      close: async () => { doubles.closed += 1; },
    } as unknown as DbHandle),
  };
});

vi.mock('../../../../src/server/sync-tick', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    runSyncTick: async (deps: SyncTickDeps): Promise<SyncTickResult> => {
      doubles.tickDeps.push(deps);
      const enqueued = (await deps.recommendationSchedules?.()) ?? 0;
      return {
        ok: true, provisioned: 0, repaired: 0, integrationSchedules: 0, enqueued,
        requeued: 0, drained: 0, released: 0, budgetHit: false, ms: 0,
      };
    },
  };
});

const SECRET = ['synthetic', 'cron', 'secret', 'value'].join('-');
const REVISION = 'e'.repeat(40);
const LEGACY_AUTHORITY = { protocol: 'legacy', admission: 'legacy', epoch: 0, authorized_revision: null };
const FENCED_BLOCKED_AUTHORITY = {
  protocol: 'fenced', admission: 'blocked', epoch: 2, authorized_revision: REVISION,
};
const ENV_KEYS = [
  'CRON_SECRET',
  'DATABASE_URL',
  'OPENSPELL_EVO_REPORT_LANE_READY',
  'OPENSPELL_CREATIVE_SYNC_PRODUCER_READY',
  'OPENSPELL_CREATIVE_SYNC_PROFILE_ALLOWLIST',
  'OPENSPELL_RECOMMENDATION_LANE_READY',
  'OPENSPELL_RECOMMENDATION_LANE_REVISION',
  'WIZARD_ADS_WEEKLY_RECOMMENDATION_RUNS',
  'LWA_CLIENT_ID',
  'LWA_CLIENT_SECRET',
  'AMAZON_LWA_CLIENT_ID',
  'AMAZON_LWA_CLIENT_SECRET',
] as const;

function request(authorization?: string): Request {
  const headers = new Headers();
  if (authorization !== undefined) headers.set('authorization', authorization);
  return new Request('https://example.test/api/cron/sync', { headers });
}

/** Everything a tick needs except the recommendation lane, which each case sets. */
function configureWiredTick(): void {
  process.env['CRON_SECRET'] = SECRET;
  process.env['DATABASE_URL'] = 'postgres://synthetic:synthetic@127.0.0.1:1/synthetic';
  process.env['WIZARD_ADS_WEEKLY_RECOMMENDATION_RUNS'] = '1';
  // The Amazon client is constructed (never used) before the tick; it only
  // needs the LWA identity to exist.
  process.env['AMAZON_LWA_CLIENT_ID'] = ['synthetic', 'lwa', 'client', 'id'].join('-');
  process.env['AMAZON_LWA_CLIENT_SECRET'] = ['synthetic', 'lwa', 'client', 'value'].join('-');
}

describe('GET /api/cron/sync', () => {
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved.set(key, process.env[key]);
      delete process.env[key];
    }
    doubles.authorityRows = [];
    doubles.authoritySql.mockReset();
    doubles.authoritySql.mockImplementation(async () => doubles.authorityRows);
    doubles.begin.mockClear();
    doubles.closed = 0;
    doubles.tickDeps = [];
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('is 401 when no CRON_SECRET is configured, even with a bearer', async () => {
    const response = await GET(request(`Bearer ${SECRET}`));
    expect(response.status).toBe(401);
  });

  it('is 401 with the secret set but no Authorization header', async () => {
    process.env['CRON_SECRET'] = SECRET;
    const response = await GET(request());
    expect(response.status).toBe(401);
  });

  it('is 401 with a wrong bearer token', async () => {
    process.env['CRON_SECRET'] = SECRET;
    const response = await GET(request('Bearer not-the-secret'));
    expect(response.status).toBe(401);
  });

  it('gets past the gate with the right bearer, then fails on the missing database', async () => {
    process.env['CRON_SECRET'] = SECRET;
    const response = await GET(request(`Bearer ${SECRET}`));
    // Not 401: the gate opened. 500 naming the database is the next failure, and
    // it happens before any Amazon call, proving the auth check is what guards
    // the expensive work.
    expect(response.status).toBe(500);
    const body = (await response.json()) as { error?: string };
    expect(body.error).toMatch(/DATABASE_URL/);
  });

  it('fails closed before the database or Amazon wiring for a malformed lane handoff', async () => {
    process.env['CRON_SECRET'] = SECRET;
    process.env['OPENSPELL_EVO_REPORT_LANE_READY'] = 'true';
    const response = await GET(request(`Bearer ${SECRET}`));
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: 'cron queue ownership is not configured safely',
    });
  });

  it('fails closed before database or Amazon wiring for malformed recommendation intent', async () => {
    process.env['CRON_SECRET'] = SECRET;
    process.env['OPENSPELL_RECOMMENDATION_LANE_READY'] = '1';
    const response = await GET(request(`Bearer ${SECRET}`));
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: 'cron queue ownership is not configured safely',
    });
  });

  it('fails closed before database or Amazon wiring for premature Creative activation', async () => {
    process.env['CRON_SECRET'] = SECRET;
    process.env['OPENSPELL_EVO_REPORT_LANE_READY'] = '0';
    process.env['OPENSPELL_CREATIVE_SYNC_PRODUCER_READY'] = '1';
    process.env['OPENSPELL_CREATIVE_SYNC_PROFILE_ALLOWLIST'] =
      '11111111-2222-4333-8444-555555555555';
    const response = await GET(request(`Bearer ${SECRET}`));
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: 'cron queue ownership is not configured safely',
    });
  });

  it('fails closed before database or Amazon wiring when the active cohort is absent', async () => {
    process.env['CRON_SECRET'] = SECRET;
    process.env['OPENSPELL_EVO_REPORT_LANE_READY'] = '1';
    process.env['OPENSPELL_CREATIVE_SYNC_PRODUCER_READY'] = '1';
    const response = await GET(request(`Bearer ${SECRET}`));
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: 'cron queue ownership is not configured safely',
    });
  });

  describe('recommendation ownership', () => {
    it('keeps Vercel cron as the recommendations.run claimant in legacy mode and hands it off only with enabled intent', () => {
      // Deployed job sets, not a producer flag, decide who claims manual previews.
      expect(cronSyncJobTypesFromEnv({})).toContain('recommendations.run');
      expect(cronSyncJobTypesFromEnv({ OPENSPELL_RECOMMENDATION_LANE_READY: '0' }))
        .toContain('recommendations.run');
      expect(cronSyncJobTypesFromEnv({
        OPENSPELL_RECOMMENDATION_LANE_READY: '1',
        OPENSPELL_RECOMMENDATION_LANE_REVISION: REVISION,
      })).not.toContain('recommendations.run');
    });

    it('composes no scheduled recommendation producer from legacy manual readiness', async () => {
      // The exact authority state under which the manual routes answer 202 legacy.
      doubles.authorityRows = [LEGACY_AUTHORITY];
      for (const ready of [undefined, '0']) {
        doubles.tickDeps = [];
        doubles.authoritySql.mockClear();
        configureWiredTick();
        if (ready === undefined) delete process.env['OPENSPELL_RECOMMENDATION_LANE_READY'];
        else process.env['OPENSPELL_RECOMMENDATION_LANE_READY'] = ready;

        const response = await GET(request(`Bearer ${SECRET}`));
        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toMatchObject({ ok: true, enqueued: 0 });
        expect(doubles.tickDeps).toHaveLength(1);
        expect(doubles.tickDeps[0]?.recommendationSchedules).toBeUndefined();
        // Not even consulted: the scheduler decision never reads legacy authority.
        expect(doubles.authoritySql).not.toHaveBeenCalled();
        expect(doubles.begin).not.toHaveBeenCalled();
      }
    });

    it('composes the producer only for enabled intent and still gates it on fenced authority', async () => {
      configureWiredTick();
      process.env['OPENSPELL_RECOMMENDATION_LANE_READY'] = '1';
      process.env['OPENSPELL_RECOMMENDATION_LANE_REVISION'] = REVISION;

      for (const authority of [LEGACY_AUTHORITY, FENCED_BLOCKED_AUTHORITY]) {
        doubles.authorityRows = [authority];
        doubles.tickDeps = [];
        doubles.authoritySql.mockClear();
        const response = await GET(request(`Bearer ${SECRET}`));
        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toMatchObject({ ok: true, enqueued: 0 });
        expect(doubles.tickDeps[0]?.recommendationSchedules).toBeTypeOf('function');
        // The hook ran, read fresh authority once, and refused before minting.
        expect(doubles.authoritySql).toHaveBeenCalledTimes(1);
        expect(doubles.begin).not.toHaveBeenCalled();
      }
    });

    it('never composes the producer without the weekly-runs operator approval', async () => {
      configureWiredTick();
      delete process.env['WIZARD_ADS_WEEKLY_RECOMMENDATION_RUNS'];
      process.env['OPENSPELL_RECOMMENDATION_LANE_READY'] = '1';
      process.env['OPENSPELL_RECOMMENDATION_LANE_REVISION'] = REVISION;
      doubles.authorityRows = [{
        protocol: 'fenced', admission: 'scoped', epoch: 3, authorized_revision: REVISION,
      }];
      const response = await GET(request(`Bearer ${SECRET}`));
      expect(response.status).toBe(200);
      expect(doubles.tickDeps[0]?.recommendationSchedules).toBeUndefined();
      expect(doubles.authoritySql).not.toHaveBeenCalled();
    });
  });
});
