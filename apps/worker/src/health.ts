import { createServer, type Server } from 'node:http';
import type { SyncWorker } from './worker.js';
import { MARKETING_STREAM_SUSTAINED_FAILURE_THRESHOLD } from './marketing-stream-sqs.js';
import type { WorkerDeploymentRole } from './deployment-role.js';
import type { JobType } from '@wizard-ads/shared';

export interface WorkerHealthComponents {
  deployment: {
    revision: string;
    role: WorkerDeploymentRole;
    jobTypes: readonly JobType[] | 'all';
  };
  marketingStream?: { status(): {
    enabled: boolean;
    running: boolean;
    stopping: boolean;
    lastSuccessAt?: string | null;
    lastErrorAt?: string | null;
    queueConfigured?: boolean;
    consecutiveFailures?: number;
  } };
}

export function startHealthServer(
  worker: SyncWorker,
  port: number,
  components: WorkerHealthComponents,
  host = '0.0.0.0',
): Promise<Server> {
  const server = createServer((request, response) => {
    if (request.method !== 'GET' || request.url !== '/healthz') {
      response.writeHead(404).end();
      return;
    }
    const marketingStream = components.marketingStream?.status() ?? { enabled: false, running: false, stopping: false };
    const streamDead = marketingStream.enabled && (
      !marketingStream.running
      || marketingStream.stopping
      || marketingStream.queueConfigured === false
      || (marketingStream.consecutiveFailures ?? 0) >= MARKETING_STREAM_SUSTAINED_FAILURE_THRESHOLD
    );
    const workerStatus = worker.status();
    const workerDead = !workerStatus.claimLoop.ready;
    const degraded = streamDead || workerDead;
    const body = JSON.stringify({
      status: degraded ? 'degraded' : 'ok',
      worker: {
        stopping: workerStatus.stopping,
        running: workerStatus.running,
        claimLoop: workerStatus.claimLoop,
      },
      deployment: {
        ...components.deployment,
        revision: publicWorkerRevision(components.deployment.revision),
      },
      components: {
        marketingStream,
      },
    });
    response.writeHead(degraded ? 503 : 200, {
      'content-type': 'application/json', 'content-length': Buffer.byteLength(body),
    });
    response.end(body);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(server));
  });
}

function publicWorkerRevision(value: string): string {
  const revision = value.trim().toLowerCase();
  return /^[0-9a-f]{7,64}$/.test(revision) ? revision : 'unknown';
}

export function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
