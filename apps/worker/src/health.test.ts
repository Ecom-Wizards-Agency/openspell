import { afterEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { SyncWorker } from './worker.js';
import { closeServer, startHealthServer } from './health.js';

describe('worker health readiness', () => {
  const servers: Awaited<ReturnType<typeof startHealthServer>>[] = [];
  afterEach(async () => Promise.all(servers.splice(0).map(closeServer)));

  it('degrades readiness when enabled Marketing Stream ingestion is not running', async () => {
    const worker = { status: () => ({ workerId: 'synthetic', stopping: false, running: 0 }) } as SyncWorker;
    const server = await startHealthServer(worker, 0, {
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
    const worker = { status: () => ({ workerId: 'synthetic', stopping: false, running: 0 }) } as SyncWorker;
    for (const [consecutiveFailures, expected] of [[0, 200], [3, 503]] as const) {
      const server = await startHealthServer(worker, 0, {
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
    const worker = { status: () => ({ workerId: 'synthetic', stopping: false, running: 0 }) } as SyncWorker;
    const server = await startHealthServer(worker, 0, {
      queueOwnership: {
        role: 'evo-report-lane',
        jobTypes: ['creative.sync', 'report.request', 'report.poll', 'report.fetch'],
      },
    });
    servers.push(server);
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/healthz`);
    await expect(response.json()).resolves.toMatchObject({
      components: {
        queueOwnership: {
          role: 'evo-report-lane',
          jobTypes: ['creative.sync', 'report.request', 'report.poll', 'report.fetch'],
        },
      },
    });
  });
});
