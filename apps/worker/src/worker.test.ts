import { gzipSync } from 'node:zlib';
import type { ClaimedJob, JobOutcome } from '@wizard-ads/db';
import type { JobPayload, Region } from '@wizard-ads/shared';
import { describe, expect, it } from 'vitest';
import type { AdsApiClient, AdsProfileContext, AdsReportStatus, CreateReportInput } from './ads-api.js';
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
      release: async () => 0,
      profile: async () => profile(),
      syncEntities: async () => ({ listed: 0, upserted: 0, changes: 0 }),
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

class OneRowApi implements AdsApiClient {
  async listEntities() { return []; }
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
