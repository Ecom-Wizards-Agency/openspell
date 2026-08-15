import { gzipSync } from 'node:zlib';
import type { ClaimedJob, JobOutcome } from '@wizard-ads/db';
import type { JobPayload, Region } from '@wizard-ads/shared';
import { describe, expect, it } from 'vitest';
import type { CrosscheckIngestResult } from '@wizard-ads/crosscheck-cli';
import type { AdsApiClient, AdsProfileContext, AdsReportStatus, CreateReportInput } from './ads-api.js';
import { resolveSourcePath } from './crosscheck.js';
import type { ParsedFactBatch } from './parsers.js';
import { RegionTokenBuckets } from './region-token-buckets.js';
import { ParsedLoadedMismatch, type ReportRequestState, type WorkerStore } from './store.js';
import { SyncWorker } from './worker.js';

const orgId = '11111111-1111-4111-8111-111111111111';
const profileId = '22222222-2222-4222-8222-222222222222';
const reportRequestId = '33333333-3333-4333-8333-333333333333';
const jobId = '44444444-4444-4444-8444-444444444444';

describe('fetch handler count assertion', () => {
  it('fails and requeues when the fact sink reports fewer loaded rows than parsed rows', async () => {
    const payload: Extract<JobPayload, { type: 'report.fetch' }> = {
      type: 'report.fetch', orgId, profileId, reportRequestId,
      amazonReportId: 'amazon-report', downloadUrl: 'https://reports.invalid/report',
    };
    const job: ClaimedJob = {
      id: jobId, orgId, profileId, jobType: payload.type, payload,
      attempts: 1, maxAttempts: 5, dedupeKey: null, claimedBy: 'unit-worker',
    };
    let claimed = false;
    let outcome: JobOutcome | undefined;
    let completedCounts: { parsed: number; loaded: number } | undefined;
    const report: ReportRequestState = {
      id: reportRequestId, reportType: 'spCampaigns', amazonReportId: 'amazon-report',
      requestedAt: new Date(), pollAttempts: 0,
    };
    const store: WorkerStore = {
      claim: async () => claimed ? [] : (claimed = true, [job]),
      finish: async (_id, nextOutcome) => { outcome = nextOutcome; },
      deadLetter: async () => {},
      release: async () => 0,
      requeueStale: async () => 0,
      profile: async () => profile(),
      syncEntities: async () => ({ listed: 0, upserted: 0, changes: 0, tombstoned: 0 }),
      provisionSchedules: async () => 0,
      unscheduledProfiles: async () => [],
      ensureReportRequest: async () => report,
      setReportCreated: async () => {},
      getReportRequest: async () => report,
      updateReportPoll: async () => {},
      enqueue: async () => true,
      loadFacts: async (_batch: ParsedFactBatch) => 0,
      completeReport: async (_id, counts) => {
        completedCounts = counts;
        if (counts.parsed !== counts.loaded) throw new ParsedLoadedMismatch(counts.parsed, counts.loaded);
      },
    };
    const worker = new SyncWorker({
      workerId: 'unit-worker', store, adsApi: new OneRowApi(),
      buckets: new RegionTokenBuckets(2), logger: { info: () => {}, error: () => {} },
    });

    expect(await worker.drainOnce()).toBe(1);
    expect(completedCounts).toMatchObject({ parsed: 1, loaded: 0 });
    expect(outcome).toBe('failed');
  });
});

describe('crosscheck.ingest retry policy', () => {
  const payload: Extract<JobPayload, { type: 'crosscheck.ingest' }> = {
    type: 'crosscheck.ingest', orgId, profileId, date: '2026-08-13', sourcePath: 'inbox/profile-1',
  };

  function run(thrown?: Error) {
    const job: ClaimedJob = {
      id: jobId, orgId, profileId, jobType: payload.type, payload,
      attempts: 1, maxAttempts: 5, dedupeKey: null, claimedBy: 'unit-worker',
    };
    const calls: { finish: JobOutcome[]; dead: string[] } = { finish: [], dead: [] };
    let claimed = false;
    const store = {
      ...stubStore(),
      claim: async () => claimed ? [] : (claimed = true, [job]),
      finish: async (_id: string, outcome: JobOutcome) => { calls.finish.push(outcome); },
      deadLetter: async (_id: string, error: string) => { calls.dead.push(error); },
    } satisfies WorkerStore;
    const worker = new SyncWorker({
      workerId: 'unit-worker', store, adsApi: new OneRowApi(),
      buckets: new RegionTokenBuckets(2), logger: { info: () => {}, error: () => {} },
      crosscheckIngest: async () => {
        if (thrown) throw thrown;
        return ingestResult('mismatch');
      },
    });
    return { worker, calls };
  }

  it('succeeds on a mismatch verdict, because the verdict is the product', async () => {
    const { worker, calls } = run();
    expect(await worker.drainOnce()).toBe(1);
    expect(calls).toEqual({ finish: ['succeeded'], dead: [] });
  });

  it('retries a transient failure', async () => {
    const { worker, calls } = run(named('NoExportsFound', 'nothing at inbox/profile-1'));
    expect(await worker.drainOnce()).toBe(1);
    expect(calls).toEqual({ finish: ['failed'], dead: [] });
  });

  it.each(['ExportContractError', 'ProfileNotFound'])('dead-letters %s without spending attempts', async (name) => {
    const { worker, calls } = run(named(name, `${name} detail`));
    expect(await worker.drainOnce()).toBe(1);
    expect(calls.finish).toEqual([]);
    expect(calls.dead).toEqual([`${name} detail`]);
  });

  it('dead-letters rather than retrying when no ingest is wired', async () => {
    const job: ClaimedJob = {
      id: jobId, orgId, profileId, jobType: payload.type, payload,
      attempts: 1, maxAttempts: 5, dedupeKey: null, claimedBy: 'unit-worker',
    };
    let claimed = false;
    const dead: string[] = [];
    const worker = new SyncWorker({
      workerId: 'unit-worker', adsApi: new OneRowApi(),
      buckets: new RegionTokenBuckets(2), logger: { info: () => {}, error: () => {} },
      store: {
        ...stubStore(),
        claim: async () => claimed ? [] : (claimed = true, [job]),
        deadLetter: async (_id, error) => { dead.push(error); },
      },
    });
    expect(await worker.drainOnce()).toBe(1);
    expect(dead).toEqual(['crosscheck ingest is not configured on this worker']);
  });
});

describe('resolveSourcePath', () => {
  it('reads a relative payload path against the configured inbox root', () => {
    expect(resolveSourcePath('profile-1/2026-08-13', '/srv/inbox')).toBe('/srv/inbox/profile-1/2026-08-13');
  });
  it('leaves an absolute payload path alone', () => {
    expect(resolveSourcePath('/elsewhere/export', '/srv/inbox')).toBe('/elsewhere/export');
  });
  it('passes the path through when no inbox root is configured', () => {
    expect(resolveSourcePath('profile-1', undefined)).toBe('profile-1');
  });
});

function named(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

function ingestResult(headline: CrosscheckIngestResult['summary']['headline']): CrosscheckIngestResult {
  return {
    profile: {
      profileId, orgId, amazonProfileId: 'profile-1', region: 'NA',
      currencyCode: 'USD', timezone: 'UTC', accountLabel: null,
    },
    files: [], filesParsed: 2, rowsParsed: 40, rowsKept: 12, findings: [], written: 0,
    summary: {
      profileDaysCompared: 3, profileDaysSkipped: 1,
      campaignsCompared: 4, campaignsSkippedIdle: 0, headline,
    },
  };
}

function stubStore(): WorkerStore {
  return {
    claim: async () => [],
    finish: async () => {},
    deadLetter: async () => {},
    release: async () => 0,
    requeueStale: async () => 0,
    profile: async () => profile(),
    syncEntities: async () => ({ listed: 0, upserted: 0, changes: 0, tombstoned: 0 }),
    provisionSchedules: async () => 0,
    unscheduledProfiles: async () => [],
    ensureReportRequest: async () => { throw new Error('unused'); },
    setReportCreated: async () => {},
    getReportRequest: async () => { throw new Error('unused'); },
    updateReportPoll: async () => {},
    enqueue: async () => true,
    loadFacts: async () => 0,
    completeReport: async () => {},
  };
}

class OneRowApi implements AdsApiClient {
  async listEntities() { return { rows: [], succeeded: ['SP', 'SB', 'SD'] as const, failures: [] }; }
  async createReport(_input: CreateReportInput) { return { reportId: 'unused' }; }
  async getReport(_profile: AdsProfileContext, _reportId: string): Promise<AdsReportStatus> { return { status: 'PENDING' }; }
  async downloadReport(): Promise<AsyncIterable<Uint8Array>> {
    const bytes = gzipSync(JSON.stringify([{ date: '2026-08-14', campaignId: 'c-1', impressions: 1, clicks: 1, cost: 1 }]));
    return (async function* stream() { yield bytes; })();
  }
  async listProfiles(_region: Region) { return []; }
}

function profile(): AdsProfileContext {
  return { id: profileId, orgId, amazonProfileId: 'profile-1', region: 'NA', currencyCode: 'USD', timezone: 'UTC' };
}
