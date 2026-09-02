import { afterEach, describe, expect, it } from 'vitest';
import type {
  RecommendationWorkerAuthority,
  RecommendationWorkerDatabase,
} from '@wizard-ads/db/recommendation-worker';
import type { RecommendationClaimant, RecommendationClaimantStatus } from './claimant.js';
import type { RecommendationLaneConfig } from './config.js';
import { listenRecommendationHealth, RecommendationHealthMonitor } from './health.js';

const REVISION = 'a'.repeat(40);
const CONFIG: RecommendationLaneConfig = {
  databaseUrl: 'postgres://fixture.invalid/database',
  workerId: 'recommendation-health-fixture',
  revision: REVISION,
  role: 'evo-recommendation-lane',
  claimProtocol: 'recommendation-fenced-v1',
  jobTypes: ['recommendations.run'],
  claimBatchSize: 1,
  maxConcurrentJobs: 1,
  claimArmed: true,
  pollIntervalMs: 1_000,
  shutdownDrainMs: 25_000,
  healthHost: '127.0.0.1',
  healthPort: 3_002,
};
const MATCHING: RecommendationWorkerAuthority = {
  protocol: 'fenced',
  admission: 'scoped',
  epoch: 3,
  authorizedRevision: REVISION,
};

class FakeDatabase {
  authority: RecommendationWorkerAuthority = MATCHING;
  failure = false;

  async getAuthority(): Promise<RecommendationWorkerAuthority> {
    if (this.failure) throw new Error('synthetic database outage with sensitive detail');
    return this.authority;
  }
}

class FakeClaimant {
  state: RecommendationClaimantStatus = {
    phase: 'idle',
    ready: true,
    inFlight: 0 as const,
    resumeComplete: true,
    settlementFailure: null,
  };

  status() {
    return this.state;
  }
}

describe('recommendation worker health', () => {
  const servers: Array<Awaited<ReturnType<typeof listenRecommendationHealth>>> = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
      server.close(() => resolve());
    })));
  });

  it('reports standby while unarmed and ok only for exact armed custody', async () => {
    const database = new FakeDatabase();
    const claimant = new FakeClaimant();
    const standby = new RecommendationHealthMonitor(
      { ...CONFIG, claimArmed: false },
      database as unknown as RecommendationWorkerDatabase,
      claimant as unknown as RecommendationClaimant,
      MATCHING,
    );
    await expect(standby.snapshot()).resolves.toMatchObject({
      statusCode: 200,
      body: {
        status: 'standby',
        deployment: {
          revision: REVISION,
          role: 'evo-recommendation-lane',
          claimProtocol: 'recommendation-fenced-v1',
          jobTypes: ['recommendations.run'],
        },
        authority: { protocol: 'fenced', admission: 'scoped', revisionMatches: true },
        claimant: { ready: true, inFlight: 0, settlementFailure: false },
      },
    });

    const armed = new RecommendationHealthMonitor(
      CONFIG,
      database as unknown as RecommendationWorkerDatabase,
      claimant as unknown as RecommendationClaimant,
      MATCHING,
    );
    await expect(armed.snapshot()).resolves.toMatchObject({
      statusCode: 200,
      body: { status: 'ok' },
    });
  });

  it('latches degraded after authority drift, database loss, or settlement failure', async () => {
    const database = new FakeDatabase();
    const claimant = new FakeClaimant();
    const monitor = new RecommendationHealthMonitor(
      CONFIG,
      database as unknown as RecommendationWorkerDatabase,
      claimant as unknown as RecommendationClaimant,
      MATCHING,
    );

    database.authority = { ...MATCHING, authorizedRevision: 'b'.repeat(40), epoch: 4 };
    await expect(monitor.snapshot()).resolves.toMatchObject({
      statusCode: 503,
      body: { status: 'degraded', authority: { revisionMatches: false } },
    });

    database.authority = MATCHING;
    database.failure = true;
    const unavailable = await monitor.snapshot();
    expect(unavailable.statusCode).toBe(503);
    expect(JSON.stringify(unavailable.body)).not.toContain('sensitive');

    database.failure = false;
    claimant.state = {
      phase: 'failed',
      ready: false,
      inFlight: 0,
      resumeComplete: true,
      settlementFailure: 'custody_lost',
    };
    await expect(monitor.snapshot()).resolves.toMatchObject({
      statusCode: 503,
      body: { status: 'degraded', claimant: { settlementFailure: true } },
    });
  });

  it('serves only a capability-free loopback health document', async () => {
    const database = new FakeDatabase();
    const claimant = new FakeClaimant();
    const monitor = new RecommendationHealthMonitor(
      CONFIG,
      database as unknown as RecommendationWorkerDatabase,
      claimant as unknown as RecommendationClaimant,
      MATCHING,
    );
    const server = await listenRecommendationHealth(monitor, '127.0.0.1', 0);
    servers.push(server);
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('health listener unavailable');

    const response = await fetch(`http://127.0.0.1:${address.port}/healthz`);
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(body).toMatchObject({ status: 'ok' });
    const serialized = JSON.stringify(body);
    expect(serialized).not.toMatch(/database|token|secret|profile|tenant|claim_token/i);

    const missing = await fetch(`http://127.0.0.1:${address.port}/metrics`);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'not_found' });
  });
});
