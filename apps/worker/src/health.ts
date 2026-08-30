import { createServer, type Server } from 'node:http';
import type { SyncWorker } from './worker.js';

export interface WorkerHealthComponents {
  marketingStream?: { status(): {
    enabled: boolean;
    running: boolean;
    stopping: boolean;
    lastSuccessAt?: string | null;
    lastErrorAt?: string | null;
  } };
}

export function startHealthServer(
  worker: SyncWorker,
  port: number,
  components: WorkerHealthComponents = {},
): Promise<Server> {
  const server = createServer((request, response) => {
    if (request.method !== 'GET' || request.url !== '/healthz') {
      response.writeHead(404).end();
      return;
    }
    const marketingStream = components.marketingStream?.status() ?? { enabled: false, running: false, stopping: false };
    const streamDead = marketingStream.enabled && (!marketingStream.running || marketingStream.stopping);
    const body = JSON.stringify({
      status: streamDead ? 'degraded' : 'ok',
      ...worker.status(),
      components: {
        marketingStream,
      },
    });
    response.writeHead(streamDead ? 503 : 200, {
      'content-type': 'application/json', 'content-length': Buffer.byteLength(body),
    });
    response.end(body);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', () => resolve(server));
  });
}

export function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
