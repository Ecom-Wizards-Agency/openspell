import { createServer, type Server } from 'node:http';
import type {
  RecommendationWorkerAuthority,
  RecommendationWorkerDatabase,
} from '@wizard-ads/db/recommendation-worker';
import type { RecommendationClaimant } from './claimant.js';
import type { RecommendationLaneConfig } from './config.js';

export interface RecommendationWorkerHealth {
  status: 'standby' | 'ok' | 'degraded' | 'stopping';
  deployment: {
    revision: string;
    role: 'evo-recommendation-lane';
    claimProtocol: 'recommendation-fenced-v1';
    jobTypes: readonly ['recommendations.run'];
  };
  authority: {
    protocol: 'legacy' | 'fenced';
    admission: 'legacy' | 'blocked' | 'scoped';
    epoch: number;
    revisionMatches: boolean;
  };
  claimant: {
    ready: boolean;
    inFlight: 0 | 1;
    settlementFailure: boolean;
  };
}

export class RecommendationHealthMonitor {
  private lastAuthority: RecommendationWorkerAuthority;
  private everMatched: boolean;
  private stopping = false;

  constructor(
    private readonly config: RecommendationLaneConfig,
    private readonly database: RecommendationWorkerDatabase,
    private readonly claimant: RecommendationClaimant,
    initialAuthority: RecommendationWorkerAuthority,
  ) {
    this.lastAuthority = initialAuthority;
    this.everMatched = authorityMatches(config.revision, initialAuthority);
  }

  stop(): void {
    this.stopping = true;
  }

  async snapshot(): Promise<{ statusCode: 200 | 503; body: RecommendationWorkerHealth }> {
    let databaseAvailable = true;
    try {
      this.lastAuthority = await this.database.getAuthority();
    } catch {
      databaseAvailable = false;
    }
    const matches = authorityMatches(this.config.revision, this.lastAuthority);
    if (matches) this.everMatched = true;
    const claimant = this.claimant.status();
    const degraded = !databaseAvailable
      || claimant.settlementFailure !== null
      || (this.everMatched && !matches);
    const status = this.stopping
      ? 'stopping'
      : degraded
        ? 'degraded'
        : !this.config.claimArmed || !matches
          ? 'standby'
          : claimant.ready
            ? 'ok'
            : 'degraded';
    return {
      statusCode: status === 'degraded' ? 503 : 200,
      body: {
        status,
        deployment: {
          revision: this.config.revision,
          role: this.config.role,
          claimProtocol: this.config.claimProtocol,
          jobTypes: this.config.jobTypes,
        },
        authority: {
          protocol: this.lastAuthority.protocol,
          admission: this.lastAuthority.admission,
          epoch: this.lastAuthority.epoch,
          revisionMatches: matches,
        },
        claimant: {
          ready: claimant.ready,
          inFlight: claimant.inFlight,
          settlementFailure: claimant.settlementFailure !== null,
        },
      },
    };
  }
}

export async function listenRecommendationHealth(
  monitor: RecommendationHealthMonitor,
  host: '127.0.0.1' | '::1',
  port: number,
): Promise<Server> {
  const server = createServer((request, response) => {
    void (async () => {
      if (request.method !== 'GET' || request.url !== '/healthz') {
        response.writeHead(404, { 'content-type': 'application/json' });
        response.end('{"error":"not_found"}\n');
        return;
      }
      const snapshot = await monitor.snapshot();
      response.writeHead(snapshot.statusCode, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
      });
      response.end(`${JSON.stringify(snapshot.body)}\n`);
    })().catch(() => {
      response.writeHead(503, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end('{"status":"degraded"}\n');
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  return server;
}

function authorityMatches(revision: string, authority: RecommendationWorkerAuthority): boolean {
  return authority.protocol === 'fenced' && authority.authorizedRevision === revision;
}
