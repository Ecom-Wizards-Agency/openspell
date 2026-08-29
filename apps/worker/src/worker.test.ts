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
import { RetryableJobError, SyncWorker } from './worker.js';

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
      syncEntities: async () => ({ listed: 0, upserted: 0, duplicates: 0, changes: 0, tombstoned: 0 }),
      provisionSchedules: async () => 0,
      unscheduledProfiles: async () => [],
      repairOverlongLookbacks: async () => 0,
      ensureIntegrationSchedules: async () => 0,
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

/**
 * A parser that refuses rows is the honest answer to a report that changed
 * shape. What must not happen is the refusal passing silently, or a
 * deterministic drift burning five attempts and leaving five stuck-processing
 * ledger rows behind it.
 */
describe('fetch handler skip accounting', () => {
  const payload: Extract<JobPayload, { type: 'report.fetch' }> = {
    type: 'report.fetch', orgId, profileId, reportRequestId,
    amazonReportId: 'amazon-report', downloadUrl: 'https://reports.invalid/report',
  };

  function run(reportRows: unknown[]) {
    const job: ClaimedJob = {
      id: jobId, orgId, profileId, jobType: payload.type, payload,
      attempts: 1, maxAttempts: 5, dedupeKey: null, claimedBy: 'unit-worker',
    };
    const report: ReportRequestState = {
      id: reportRequestId, reportType: 'spTargeting', amazonReportId: 'amazon-report',
      requestedAt: new Date(), pollAttempts: 0,
    };
    const calls: {
      finish: { outcome: JobOutcome; result?: unknown }[];
      dead: string[];
      polls: { status: string; error?: string | null }[];
      completed: { parsed: number; loaded: number }[];
    } = { finish: [], dead: [], polls: [], completed: [] };
    let claimed = false;
    const store: WorkerStore = {
      ...stubStore(),
      claim: async () => claimed ? [] : (claimed = true, [job]),
      finish: async (_id, outcome, options) => { calls.finish.push({ outcome, result: options?.result }); },
      deadLetter: async (_id, error) => { calls.dead.push(error); },
      getReportRequest: async () => report,
      updateReportPoll: async (_id, values) => { calls.polls.push({ status: values.status, error: values.error }); },
      loadFacts: async (batch: ParsedFactBatch) => batch.rows.length,
      completeReport: async (_id, counts) => { calls.completed.push({ parsed: counts.parsed, loaded: counts.loaded }); },
    };
    const worker = new SyncWorker({
      workerId: 'unit-worker', store, adsApi: new PayloadApi(reportRows),
      buckets: new RegionTokenBuckets(2), logger: { info: () => {}, error: () => {} },
    });
    return { worker, calls };
  }

  it('succeeds, and reports what it refused, when the refusals are under the threshold', async () => {
    const rows: unknown[] = [];
    for (let index = 0; index < 200; index += 1) rows.push(targetingRow(`kw-${index}`));
    const { campaignId: _dropped, ...noCampaign } = targetingRow('kw-bad');
    rows.push(noCampaign);
    const { worker, calls } = run(rows);

    expect(await worker.drainOnce()).toBe(1);
    expect(calls.finish.map((call) => call.outcome)).toEqual(['succeeded']);
    expect(calls.completed).toEqual([{ parsed: 200, loaded: 200 }]);
    expect(calls.finish[0]?.result).toMatchObject({
      reportRows: 201, parsed: 200, loaded: 200, skipped: 1,
      skipReasons: { 'no campaignId': 1 },
    });
    // Nothing was marked failed on the way through.
    expect(calls.polls).toEqual([]);
  });

  it('fails the ledger and dead-letters when the parser refuses everything', async () => {
    const { campaignId: _dropped, ...noCampaign } = targetingRow('kw-1');
    const { worker, calls } = run([noCampaign, { ...noCampaign, keywordId: 'kw-2' }]);

    expect(await worker.drainOnce()).toBe(1);
    // No fact write was attempted, and the ledger says why rather than sitting
    // in `processing` until somebody notices.
    expect(calls.completed).toEqual([]);
    expect(calls.polls).toEqual([
      { status: 'failed', error: 'parser refused 2 of 2 rows: no campaignId (2)' },
    ]);
    // Dead, not retried: five attempts would refuse the same two rows.
    expect(calls.finish).toEqual([]);
    expect(calls.dead[0]).toContain('spTargeting parser refused 2 of 2 rows');
  });

  it('dead-letters when the refused share exceeds the threshold', async () => {
    const rows: unknown[] = [];
    for (let index = 0; index < 90; index += 1) rows.push(targetingRow(`kw-${index}`));
    for (let index = 0; index < 10; index += 1) {
      const { campaignId: _dropped, ...noCampaign } = targetingRow(`bad-${index}`);
      rows.push(noCampaign);
    }
    const { worker, calls } = run(rows);

    expect(await worker.drainOnce()).toBe(1);
    expect(calls.finish).toEqual([]);
    expect(calls.dead[0]).toContain('refused 10 of 100 rows');
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

describe('recommendations.run wiring', () => {
  const payload: Extract<JobPayload, { type: 'recommendations.run' }> = {
    type: 'recommendations.run',
    orgId,
    profileId,
    runId: reportRequestId,
    lookbackDays: 7,
    groupId: jobId,
  };

  it('delegates to the injected runner and stores its result', async () => {
    const job: ClaimedJob = {
      id: jobId, orgId, profileId, jobType: payload.type, payload,
      attempts: 1, maxAttempts: 5, dedupeKey: null, claimedBy: 'unit-worker',
    };
    let claimed = false;
    const results: unknown[] = [];
    const calls: JobPayload[] = [];
    const worker = new SyncWorker({
      workerId: 'unit-worker', adsApi: new OneRowApi(),
      buckets: new RegionTokenBuckets(2), logger: { info: () => {}, error: () => {} },
      store: {
        ...stubStore(),
        claim: async () => claimed ? [] : (claimed = true, [job]),
        finish: async (_id, outcome, options) => {
          expect(outcome).toBe('succeeded');
          results.push(options?.result);
        },
      },
      recommendationsRun: async (incoming) => {
        calls.push(incoming as JobPayload);
        return { runId: incoming.runId, proposals: 2, window: null, alreadySucceeded: false };
      },
    });

    expect(await worker.drainOnce()).toBe(1);
    expect(calls).toEqual([payload]);
    expect(results).toEqual([
      { runId: reportRequestId, proposals: 2, window: null, alreadySucceeded: false },
    ]);
  });

  it('dead-letters when no recommendations runner is configured', async () => {
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
    expect(dead).toEqual(['recommendations runner is not configured on this worker']);
  });
});

describe('integration handler wiring', () => {
  const payloads: JobPayload[] = [
    { type: 'keepa.sync', orgId, profileId, includeCompetitors: true },
    { type: 'rank.sync', orgId, profileId },
    { type: 'economics.sync', orgId, profileId },
    { type: 'sqp.categorize', orgId, profileId, weekStart: '2026-08-23' },
  ];

  it('delegates all four payloads without constructing an Ads client', async () => {
    let claimed = false;
    const called: string[] = [];
    const results: unknown[] = [];
    const jobs = payloads.map((payload, index): ClaimedJob => ({
      id: `${index + 1}`.repeat(8) + '-1111-4111-8111-111111111111',
      orgId,
      profileId,
      jobType: payload.type,
      payload,
      attempts: 1,
      maxAttempts: 5,
      dedupeKey: null,
      claimedBy: 'integration-worker',
    }));
    const worker = new SyncWorker({
      workerId: 'integration-worker',
      store: {
        ...stubStore(),
        claim: async () => claimed ? [] : (claimed = true, jobs),
        finish: async (_id, outcome, options) => {
          expect(outcome).toBe('succeeded');
          results.push(options?.result);
        },
      },
      integrations: {
        keepaSync: async (payload) => (called.push(payload.type), { provider: 'keepa' }),
        rankSync: async (payload) => (called.push(payload.type), { provider: 'datadive' }),
        economicsSync: async (payload) => (called.push(payload.type), { provider: 'mrp' }),
        sqpCategorize: async (payload) => (called.push(payload.type), { weekStart: payload.weekStart }),
      },
      logger: { info: () => {}, error: () => {} },
    });

    expect(await worker.drainOnce()).toBe(4);
    expect(called).toEqual(payloads.map((payload) => payload.type));
    expect(results).toHaveLength(4);
  });

  it('dead-letters a job whose handler is not deployed in this runtime', async () => {
    const payload = payloads[0];
    if (!payload) throw new Error('missing test payload');
    let claimed = false;
    const dead: string[] = [];
    const worker = new SyncWorker({
      workerId: 'integration-worker',
      store: {
        ...stubStore(),
        claim: async () => claimed ? [] : (claimed = true, [{
          id: jobId, orgId, profileId, jobType: payload.type, payload,
          attempts: 1, maxAttempts: 5, dedupeKey: null, claimedBy: 'integration-worker',
        }]),
        deadLetter: async (_id, error) => { dead.push(error); },
      },
      logger: { info: () => {}, error: () => {} },
    });

    expect(await worker.drainOnce()).toBe(1);
    expect(dead).toEqual(['keepa.sync handler not deployed in this runtime']);
  });

  it('uses an integration handler retry delay in the queue ledger', async () => {
    const payload = payloads[1];
    if (!payload || payload.type !== 'rank.sync') throw new Error('missing rank payload');
    let claimed = false;
    const finishes: { outcome: JobOutcome; retryIn: string | undefined }[] = [];
    const worker = new SyncWorker({
      workerId: 'integration-worker',
      store: {
        ...stubStore(),
        claim: async () => claimed ? [] : (claimed = true, [{
          id: jobId, orgId, profileId, jobType: payload.type, payload,
          attempts: 1, maxAttempts: 5, dedupeKey: null, claimedBy: 'integration-worker',
        }]),
        finish: async (_id, outcome, options) => {
          finishes.push({ outcome, retryIn: options?.retryIn });
        },
      },
      integrations: {
        rankSync: async () => { throw new RetryableJobError('quota exhausted', 3_600); },
      },
      logger: { info: () => {}, error: () => {} },
    });

    expect(await worker.drainOnce()).toBe(1);
    expect(finishes).toEqual([{ outcome: 'failed', retryIn: '3600 seconds' }]);
  });

  it('passes the configured job-type allowlist into every claim', async () => {
    const filters: (readonly string[] | undefined)[] = [];
    const worker = new SyncWorker({
      workerId: 'integration-worker',
      store: { ...stubStore(), claim: async (_id, _limit, jobTypes) => (filters.push(jobTypes), []) },
      jobTypes: ['keepa.sync', 'rank.sync'],
    });

    expect(await worker.drainOnce()).toBe(0);
    expect(filters).toEqual([['keepa.sync', 'rank.sync']]);
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
    syncEntities: async () => ({ listed: 0, upserted: 0, duplicates: 0, changes: 0, tombstoned: 0 }),
    provisionSchedules: async () => 0,
    unscheduledProfiles: async () => [],
    repairOverlongLookbacks: async () => 0,
    ensureIntegrationSchedules: async () => 0,
    ensureReportRequest: async () => { throw new Error('unused'); },
    setReportCreated: async () => {},
    getReportRequest: async () => { throw new Error('unused'); },
    updateReportPoll: async () => {},
    enqueue: async () => true,
    loadFacts: async () => 0,
    completeReport: async () => {},
  };
}

/** A synthetic `spTargeting` row in the shape Amazon sends: `keywordId`, no `targetId`. */
function targetingRow(keywordId: string): Record<string, unknown> {
  return {
    date: '2026-08-14', campaignId: 'c-1', adGroupId: 'ag-1', keywordId,
    matchType: 'EXACT', impressions: 10, clicks: 1, cost: 0.5,
    purchases7d: 0, sales7d: 0, unitsSoldClicks7d: 0,
  };
}

/** Serves whatever report payload a case hands it. */
class PayloadApi implements AdsApiClient {
  constructor(private readonly rows: unknown[]) {}
  async listEntities() { return { rows: [], succeeded: ['SP', 'SB', 'SD'] as const, failures: [] }; }
  async createReport(_input: CreateReportInput) { return { reportId: 'unused' }; }
  async getReport(_profile: AdsProfileContext, _reportId: string): Promise<AdsReportStatus> { return { status: 'PENDING' }; }
  async downloadReport(): Promise<AsyncIterable<Uint8Array>> {
    const bytes = gzipSync(JSON.stringify(this.rows));
    return (async function* stream() { yield bytes; })();
  }
  async listProfiles(_region: Region) { return []; }
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
