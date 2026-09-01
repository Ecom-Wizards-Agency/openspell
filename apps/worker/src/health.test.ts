import { afterEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { SyncWorker } from './worker.js';
import { closeServer, startHealthServer } from './health.js';

const readyClaimLoop = {
  phase: 'idle_wait',
  ready: true,
  consecutiveFailures: 0,
  lastSuccessAt: '2026-09-02T00:00:00.000Z',
  lastFailureAt: null,
  failureKind: null,
  retryInMs: null,
} as const;

describe('worker health readiness', () => {
  const servers: Awaited<ReturnType<typeof startHealthServer>>[] = [];
  const deployment = {
    revision: 'abcdef1234567',
    role: 'evo-report-lane' as const,
    jobTypes: ['creative.sync', 'report.request', 'report.poll', 'report.fetch'] as const,
  };
  afterEach(async () => Promise.all(servers.splice(0).map(closeServer)));

  it('degrades readiness when enabled Marketing Stream ingestion is not running', async () => {
    const worker = {
      status: () => ({ workerId: 'synthetic', stopping: false, running: 0, claimLoop: readyClaimLoop }),
    } as SyncWorker;
    const server = await startHealthServer(worker, 0, {
      deployment,
      marketingStream: {
        status: () => ({ enabled: true, running: false, stopping: false }),
      },
    });
    servers.push(server);
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ status: 'degraded' });
  });

  it('stays ready for an empty healthy queue but degrades after sustained failures', async () => {
    const worker = {
      status: () => ({ workerId: 'synthetic', stopping: false, running: 0, claimLoop: readyClaimLoop }),
    } as SyncWorker;
    for (const [consecutiveFailures, expected] of [[0, 200], [3, 503]] as const) {
      const server = await startHealthServer(worker, 0, {
        deployment,
        marketingStream: { status: () => ({
          enabled: true, running: true, stopping: false, queueConfigured: true,
          consecutiveFailures, lastSuccessAt: null,
        }) },
      });
      servers.push(server);
      const { port } = server.address() as AddressInfo;
      expect((await fetch(`http://127.0.0.1:${port}/healthz`)).status).toBe(expected);
    }
  });

  it('reports only the sanitized role and queue allowlist for deployment ownership', async () => {
    const worker = {
      status: () => ({ workerId: 'synthetic', stopping: false, running: 0, claimLoop: readyClaimLoop }),
    } as SyncWorker;
    const server = await startHealthServer(worker, 0, {
      deployment,
    });
    servers.push(server);
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/healthz`);
    await expect(response.json()).resolves.toMatchObject({
      worker: { stopping: false, running: 0 },
      deployment: {
        revision: 'abcdef1234567',
        role: 'evo-report-lane',
        jobTypes: ['creative.sync', 'report.request', 'report.poll', 'report.fetch'],
      },
    });
    expect(JSON.stringify(await (await fetch(`http://127.0.0.1:${port}/healthz`)).json()))
      .not.toContain('synthetic');
  });

  it('never echoes an embedding caller\'s unsanitized revision value', async () => {
    const worker = {
      status: () => ({ workerId: 'synthetic', stopping: false, running: 0, claimLoop: readyClaimLoop }),
    } as SyncWorker;
    const server = await startHealthServer(worker, 0, {
      deployment: { ...deployment, revision: 'release/private-host-detail' },
    });
    servers.push(server);
    const { port } = server.address() as AddressInfo;
    const payload = await (await fetch(`http://127.0.0.1:${port}/healthz`)).json() as {
      deployment: { revision: string };
    };
    expect(payload.deployment.revision).toBe('unknown');
    expect(JSON.stringify(payload)).not.toContain('private-host-detail');
  });

  it('can bind the health endpoint to loopback only', async () => {
    const worker = {
      status: () => ({ workerId: 'synthetic', stopping: false, running: 0, claimLoop: readyClaimLoop }),
    } as SyncWorker;
    const server = await startHealthServer(worker, 0, { deployment }, '127.0.0.1');
    servers.push(server);
    const address = server.address() as AddressInfo;
    expect(address.address).toBe('127.0.0.1');
    expect((await fetch(`http://127.0.0.1:${address.port}/healthz`)).status).toBe(200);
  });

  it.each([
    ['not_started', 0, false, 503],
    ['claiming', 0, true, 200],
    ['backing_off', 2, true, 200],
    ['backing_off', 3, false, 503],
    ['stopping', 0, false, 503],
    ['stopped', 0, false, 503],
    ['failed', 0, false, 503],
  ] as const)(
    'reports %s with %i failures at its truthful readiness',
    async (phase, consecutiveFailures, ready, expectedStatus) => {
      const claimLoop = {
        ...readyClaimLoop,
        phase,
        ready,
        consecutiveFailures,
        failureKind: consecutiveFailures > 0 ? 'postgres_query_cancelled' as const : null,
      };
      const worker = {
        status: () => ({
          workerId: 'synthetic',
          stopping: phase === 'stopping' || phase === 'stopped',
          running: 0,
          claimLoop,
        }),
      } as SyncWorker;
      const server = await startHealthServer(worker, 0, { deployment });
      servers.push(server);
      const { port } = server.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      expect(response.status).toBe(expectedStatus);
      await expect(response.json()).resolves.toMatchObject({
        status: expectedStatus === 200 ? 'ok' : 'degraded',
        worker: { claimLoop: { phase, ready, consecutiveFailures } },
      });
    },
  );
});
