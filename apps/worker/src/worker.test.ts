import { gzipSync } from 'node:zlib';
import type {
  ClaimedJob,
  ClaimToken,
  DbHandle,
  JobOutcome,
  StagedReportDate,
} from '@wizard-ads/db';
import type { JobPayload, Region } from '@wizard-ads/shared';
import { describe, expect, it } from 'vitest';
import type { CrosscheckIngestResult } from '@wizard-ads/crosscheck-cli';
import { SpApiAuthError } from '@wizard-ads/sp-api';
import {
  DownloadUrlExpiredError,
  ReportCreateOutcomeUnknownError,
  type AdsApiClient,
  type AdsProfileContext,
  type AdsReportStatus,
  type CreateReportInput,
} from './ads-api.js';
import { resolveSourcePath } from './crosscheck.js';
import {
  RecommendationExecutionCustodyError,
  RecommendationScopeIntegrityError,
} from './recommendations-run.js';
import type { ParsedFactBatch, ReportDownloadLimits } from './parsers.js';
import { RegionTokenBuckets } from './region-token-buckets.js';
import {
  ClaimOwnershipLost,
  ParsedLoadedMismatch,
  PostgresWorkerStore,
  type ReportRequestState,
  type WorkerStore,
} from './store.js';
import { SqpWorkflowPendingError } from './sqp.js';
import type { UnifiedDualRun } from './unified-reporting.js';
import {
  RetryableJobError,
  SyncWorker,
  accountParentParsedBytes,
  shutdownExitCode,
} from './worker.js';

const orgId = '11111111-1111-4111-8111-111111111111';
const profileId = '22222222-2222-4222-8222-222222222222';
const reportRequestId = '33333333-3333-4333-8333-333333333333';
const jobId = '44444444-4444-4444-8444-444444444444';

describe('shutdown exit classification', () => {
  it('returns 78 when a signal races with fatal custody even if evidence is momentarily empty', () => {
    expect(shutdownExitCode(
      { released: 0, unresolved: 0 },
      'custody_quarantined',
    )).toBe(78);
    expect(shutdownExitCode({ released: 0, unresolved: 0 }, null)).toBe(0);
  });
});

describe('parent parsed-report heap bound', () => {
  it('fails closed before accumulated normalized rows exceed 16 MiB serialized', () => {
    expect(() => accountParentParsedBytes(16 * 1024 * 1024 - 8, { row: 'too-large' }))
      .toThrowError(expect.objectContaining({ kind: 'parsed_bytes' }));
  });
});

describe('fetch handler count assertion', () => {
  it('fails and requeues when the fact sink reports fewer loaded rows than parsed rows', async () => {
    const payload: Extract<JobPayload, { type: 'report.fetch' }> = {
      type: 'report.fetch', orgId, profileId, reportRequestId,
      amazonReportId: 'amazon-report', downloadUrl: 'https://reports.invalid/report',
    };
    const job: ClaimedJob = {
      id: jobId, orgId, profileId, jobType: payload.type, payload,
      attempts: 1, maxAttempts: 5, dedupeKey: null, claim: null, claimedBy: 'unit-worker',
    };
    let claimed = false;
    let outcome: JobOutcome | undefined;
    let completedCounts: { parsed: number; loaded: number } | undefined;
    const report: ReportRequestState = {
      id: reportRequestId, orgId, profileId, reportType: 'sbCampaigns',
      startDate: '2026-08-14', endDate: '2026-08-14', source: 'amazon_api',
      amazonReportId: 'amazon-report',
      requestedAt: new Date(), pollAttempts: 0,
    };
    const store: WorkerStore = {
      ...stubStore(),
      claim: async () => claimed ? [] : (claimed = true, [job]),
      finish: async (_id, nextOutcome) => { outcome = nextOutcome; },
      getReportRequest: async () => report,
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

describe('SB attribution-aware report accounting', () => {
  it('keeps actual parsed and valid unpromoted rows in the durable completion call', async () => {
    const payload: Extract<JobPayload, { type: 'report.fetch' }> = {
      type: 'report.fetch', orgId, profileId, reportRequestId,
      amazonReportId: 'amazon-report', downloadUrl: 'https://reports.invalid/report',
    };
    const job: ClaimedJob = {
      id: jobId, orgId, profileId, jobType: payload.type, payload,
      attempts: 1, maxAttempts: 5, dedupeKey: null, claim: null, claimedBy: 'unit-worker',
    };
    let claimed = false;
    let accounting: Parameters<WorkerStore['finishAttributedReport']>[1] | undefined;
    const store: WorkerStore = {
      ...stubStore(),
      claim: async () => claimed ? [] : (claimed = true, [job]),
      getReportRequest: async () => ({
        id: reportRequestId,
        orgId,
        profileId,
        reportType: 'sbAds',
        startDate: '2026-08-29',
        endDate: '2026-08-29',
        source: 'amazon_api',
        amazonReportId: 'amazon-report',
        requestedAt: new Date('2026-08-29T00:01:00Z'),
        pollAttempts: 1,
        creativeSyncSnapshotId: jobId,
      }),
      finishAttributedReport: async (_id, counts) => { accounting = counts; },
    };
    const worker = new SyncWorker({
      workerId: 'unit-worker',
      store,
      adsApi: new PayloadApi([{ synthetic: true }]),
      sbVideo: {
        syncSnapshot: async () => { throw new Error('unused'); },
        ingestReport: async () => ({
          blocked: false,
          idempotentReplay: false,
          reportSourceRows: 3,
          reportParsedRows: 2,
          reportRefusedRows: 1,
          mappedFactRows: 1,
          unpromotedReportRows: 1,
          factsUpserted: 1,
          factsReadBack: 1,
          amazonWriteCalls: 0,
          reasons: [],
        }),
      },
      buckets: new RegionTokenBuckets(2),
      logger: { info: () => {}, error: () => {} },
    });

    expect(await worker.drainOnce()).toBe(1);
    expect(accounting).toEqual({
      sourceRows: 3,
      parsedRows: 2,
      refusedRows: 1,
      promotedRows: 1,
      unpromotedRows: 1,
      canonicalRows: 1,
    });
  });

  it('validates the additive durable accounting before writing it', async () => {
    let statement = '';
    const sql = (async (strings: TemplateStringsArray) => {
      statement = strings.join(' ');
      return [{ id: reportRequestId, accounting_complete: true }];
    }) as unknown as DbHandle['sql'];
    const store = new PostgresWorkerStore({
      sql,
      db: {} as DbHandle['db'],
      close: async () => {},
    });
    await store.finishAttributedReport(reportRequestId, {
      sourceRows: 3,
      parsedRows: 2,
      refusedRows: 1,
      promotedRows: 1,
      unpromotedRows: 1,
      canonicalRows: 1,
    }, { status: 'completed', bytesDownloaded: 100 });
    expect(statement).toContain('source_rows =');
    expect(statement).toContain('rows_parsed =');
    expect(statement).toContain('promoted_rows =');
    expect(statement).toContain('unpromoted_rows =');
    expect(statement).toContain('rows_loaded =');

    await expect(store.finishAttributedReport(reportRequestId, {
      sourceRows: 3,
      parsedRows: 2,
      refusedRows: 0,
      promotedRows: 1,
      unpromotedRows: 1,
      canonicalRows: 0,
    }, { status: 'completed', bytesDownloaded: 100 })).rejects.toThrow();
  });
});

describe('queue deferral', () => {
  it('returns a running job to the queue without spending a failure attempt', async () => {
    let statement = '';
    const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
      statement = strings.join(' ');
      expect(values).toEqual(['211 seconds', jobId]);
      return [{ id: jobId }];
    }) as unknown as DbHandle['sql'];
    const handle: DbHandle = {
      sql,
      db: {} as DbHandle['db'],
      close: async () => {},
    };

    await new PostgresWorkerStore(handle).defer(jobId, '211 seconds');
    expect(statement).toContain('attempts = greatest(attempts - 1, 0)');
    expect(statement).toContain("status = 'running'::public.sync_job_status");
    expect(statement).toContain('claim_token is null');
  });
});

describe('fenced worker store', () => {
  it('selects fenced claim and settlement capabilities for the Evo protocol', async () => {
    const token = '55555555-5555-4555-8555-555555555555';
    const statements: string[] = [];
    const sql = Object.assign(
      async (strings: TemplateStringsArray): Promise<unknown[]> => {
        const statement = strings.join(' ');
        statements.push(statement);
        if (statement.includes('claim_sync_jobs_fenced')) {
          return [{
            id: jobId,
            org_id: orgId,
            profile_id: profileId,
            job_type: 'report.fetch',
            payload: {
              type: 'report.fetch', orgId, profileId, reportRequestId,
              amazonReportId: 'provider-report', downloadUrl: 'https://reports.invalid/fenced',
            },
            attempts: 1,
            max_attempts: 5,
            dedupe_key: null,
            claimed_by: 'evo-report:test',
            claim_token: token,
          }];
        }
        return [{ decision: 'settled', status: 'succeeded', attempts: 1 }];
      },
      { array: (values: readonly unknown[]) => values },
    ) as unknown as DbHandle['sql'];
    const store = new PostgresWorkerStore({
      sql,
      db: {} as DbHandle['db'],
      close: async () => {},
    }, undefined, { claimProtocol: 'fenced' });

    const [job] = await store.claim('evo-report:test', 1, ['report.fetch']);

    expect(job?.claim).toEqual({
      jobId,
      workerId: 'evo-report:test',
      token,
    });
    await store.finishClaim(job!.claim!, 'succeeded', { result: { loaded: 1 } });
    expect(statements).toHaveLength(2);
    expect(statements[0]).toContain('claim_sync_jobs_fenced');
    expect(statements[1]).toContain('finish_sync_job_fenced');
  });

  it('turns a stale fenced decision into a sanitized ownership failure', async () => {
    const sql = (async () => [{ decision: 'stale_claim', status: null, attempts: null }]) as unknown as DbHandle['sql'];
    const store = new PostgresWorkerStore({
      sql,
      db: {} as DbHandle['db'],
      close: async () => {},
    });
    const claim = {
      jobId,
      workerId: 'evo-report:test',
      token: '55555555-5555-4555-8555-555555555555' as ClaimToken,
    };

    await expect(store.deferClaim(claim, '5 minutes')).rejects.toBeInstanceOf(ClaimOwnershipLost);
    await expect(store.deadLetterClaim(claim, 'fixed category')).rejects.toBeInstanceOf(
      ClaimOwnershipLost,
    );
  });

  it('persists and confirms the provider id only through the exact tenant claim fence', async () => {
    const token = '55555555-5555-4555-8555-555555555555' as ClaimToken;
    const statements: Array<{ text: string; values: unknown[] }> = [];
    const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
      statements.push({ text: strings.join(' '), values });
      return [{ id: jobId }];
    }) as unknown as DbHandle['sql'];
    const store = new PostgresWorkerStore({
      sql,
      db: {} as DbHandle['db'],
      close: async () => {},
    });
    const input = {
      reportRequestId: jobId,
      orgId,
      profileId,
      amazonReportId: 'provider-report',
      nextPollAt: new Date('2026-09-02T12:00:00.000Z'),
      claim: { jobId, workerId: 'evo-report:test', token },
    };

    await expect(store.setReportCreated(input)).resolves.toBe(true);
    await expect(store.confirmReportCreated(input)).resolves.toBe(true);

    expect(statements).toHaveLength(2);
    for (const statement of statements) {
      expect(statement.text).toContain('public.sync_jobs');
      expect(statement.text).toContain('j.status = \'running\'');
      expect(statement.text).toContain('j.claimed_by');
      expect(statement.text).toContain('j.claim_token');
      expect(statement.values).toEqual(expect.arrayContaining([
        jobId, orgId, profileId, 'provider-report', 'evo-report:test', token,
      ]));
    }
    expect(statements[0]?.text).toContain('amazon_report_id is null or');
  });

  it('returns a closed refusal when a conflicting or stale claim changes no row', async () => {
    const sql = (async () => []) as unknown as DbHandle['sql'];
    const store = new PostgresWorkerStore({
      sql,
      db: {} as DbHandle['db'],
      close: async () => {},
    });
    const input = {
      reportRequestId: jobId,
      orgId,
      profileId,
      amazonReportId: 'provider-report',
      nextPollAt: new Date('2026-09-02T12:00:00.000Z'),
      claim: {
        jobId,
        workerId: 'evo-report:stale',
        token: '55555555-5555-4555-8555-555555555555' as ClaimToken,
      },
    };

    await expect(store.setReportCreated(input)).resolves.toBe(false);
    await expect(store.confirmReportCreated(input)).resolves.toBe(false);
  });
});

describe('historical report partition preparation', () => {
  it('requests every historical month and verifies the report fact table exactly', async () => {
    const sql = (async (_strings: TemplateStringsArray, ...values: unknown[]) => {
      expect(values).toEqual(['2024-01-01', 2]);
      return [
        { table_name: 'fact_sp_target_daily', partition_name: 'sp_2024_01', month: '2024-01-01', created: true },
        { table_name: 'fact_sp_target_daily', partition_name: 'sp_2024_02', month: '2024-02-01', created: false },
        { table_name: 'fact_sp_target_daily', partition_name: 'sp_2024_03', month: '2024-03-01', created: true },
      ];
    }) as unknown as DbHandle['sql'];
    const store = new PostgresWorkerStore({
      sql,
      db: {} as DbHandle['db'],
      close: async () => {},
    });

    await expect(store.ensureReportPartitions(
      'spTargeting',
      '2024-01-31',
      '2024-03-01',
    )).resolves.toEqual({ expectedMonths: 3, matchedMonths: 3, createdMonths: 2 });
  });

  it('fails when partition preparation omits a required month', async () => {
    const sql = (async () => [
      { table_name: 'fact_profile_daily', partition_name: 'profile_2024_01', month: '2024-01-01', created: true },
    ]) as unknown as DbHandle['sql'];
    const store = new PostgresWorkerStore({
      sql,
      db: {} as DbHandle['db'],
      close: async () => {},
    });

    await expect(store.ensureReportPartitions(
      'spCampaigns',
      '2024-01-01',
      '2024-02-29',
    )).rejects.toThrow(/expected 2 months, matched 1/);
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
      attempts: 1, maxAttempts: 5, dedupeKey: null, claim: null, claimedBy: 'unit-worker',
    };
    const report: ReportRequestState = {
      id: reportRequestId, orgId, profileId, reportType: 'spTargeting',
      startDate: '2026-08-14', endDate: '2026-08-14', source: 'amazon_api',
      amazonReportId: 'amazon-report',
      requestedAt: new Date(), pollAttempts: 0,
    };
    const calls: {
      finish: { outcome: JobOutcome; result?: unknown }[];
      dead: string[];
      polls: { status: string; error?: string | null }[];
      failed: string[];
      completed: { parsed: number; loaded: number }[];
    } = { finish: [], dead: [], polls: [], failed: [], completed: [] };
    let claimed = false;
    const store: WorkerStore = {
      ...stubStore(),
      claim: async () => claimed ? [] : (claimed = true, [job]),
      finish: async (_id, outcome, options) => { calls.finish.push({ outcome, result: options?.result }); },
      deadLetter: async (_id, error) => { calls.dead.push(error); },
      getReportRequest: async () => report,
      updateReportPoll: async (_id, values) => { calls.polls.push({ status: values.status, error: values.error }); },
      failReport: async (_id, error) => { calls.failed.push(error); },
      loadFacts: async (batch: ParsedFactBatch) => batch.rows.length,
      completeReport: async (_id, counts) => { calls.completed.push({ parsed: counts.parsed, loaded: counts.loaded }); },
    };
    const worker = new SyncWorker({
      workerId: 'unit-worker', store, adsApi: new PayloadApi(reportRows),
      buckets: new RegionTokenBuckets(2), logger: { info: () => {}, error: () => {} },
    });
    return { worker, calls };
  }

  it('fails closed before replacement when even one source row is refused', async () => {
    const rows: unknown[] = [];
    for (let index = 0; index < 200; index += 1) rows.push(targetingRow(`kw-${index}`));
    const { campaignId: _dropped, ...noCampaign } = targetingRow('kw-bad');
    rows.push(noCampaign);
    const { worker, calls } = run(rows);

    expect(await worker.drainOnce()).toBe(1);
    expect(calls.finish).toEqual([]);
    expect(calls.completed).toEqual([]);
    expect(calls.failed).toEqual([
      'replacement parser refused 1 of 201 rows: no campaignId (1)',
    ]);
    expect(calls.dead[0]).toContain('spTargeting replacement parser refused 1 of 201 rows');
  });

  it('fails the ledger and dead-letters when the parser refuses everything', async () => {
    const { campaignId: _dropped, ...noCampaign } = targetingRow('kw-1');
    const { worker, calls } = run([noCampaign, { ...noCampaign, keywordId: 'kw-2' }]);

    expect(await worker.drainOnce()).toBe(1);
    // No fact write was attempted, and the ledger says why rather than sitting
    // in `processing` until somebody notices.
    expect(calls.completed).toEqual([]);
    expect(calls.failed).toEqual([
      'replacement parser refused 2 of 2 rows: no campaignId (2)',
    ]);
    // Dead, not retried: five attempts would refuse the same two rows.
    expect(calls.finish).toEqual([]);
    expect(calls.dead[0]).toContain('spTargeting replacement parser refused 2 of 2 rows');
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
    expect(calls.failed).toEqual([
      'replacement parser refused 10 of 100 rows: no campaignId (10)',
    ]);
    expect(calls.dead[0]).toContain('refused 10 of 100 rows');
  });
});

describe('Sponsored Products report promotion', () => {
  const payload: Extract<JobPayload, { type: 'report.fetch' }> = {
    type: 'report.fetch', orgId, profileId, reportRequestId,
    amazonReportId: 'amazon-report', downloadUrl: 'https://reports.invalid/report',
  };

  it('promotes every complete date, including an empty day, with exact counts', async () => {
    const job: ClaimedJob = {
      id: jobId, orgId, profileId, jobType: payload.type, payload,
      attempts: 1, maxAttempts: 5, dedupeKey: null, claim: null, claimedBy: 'unit-worker',
    };
    const report: ReportRequestState = {
      id: reportRequestId, orgId, profileId, reportType: 'spTargeting',
      startDate: '2026-08-14', endDate: '2026-08-16', source: 'amazon_api',
      amazonReportId: 'amazon-report', requestedAt: new Date('2026-08-17T01:00:00Z'),
      pollAttempts: 2,
    };
    const promoted: StagedReportDate[] = [];
    const completed: { parsed: number; loaded: number; bytesDownloaded: number }[] = [];
    const outcomes: { outcome: JobOutcome; result: unknown }[] = [];
    let claimed = false;
    const store = {
      ...stubStore(),
      claim: async () => claimed ? [] : (claimed = true, [job]),
      finish: async (_id: string, outcome: JobOutcome, options?: { result?: unknown }) => {
        outcomes.push({ outcome, result: options?.result });
      },
      getReportRequest: async () => report,
      ensureReportPartitions: async () => ({ expectedMonths: 1, matchedMonths: 1, createdMonths: 1 }),
      promoteReportDate: async (date: StagedReportDate) => {
        promoted.push(date);
        return {
          status: 'promoted' as const,
          deletedRows: 0,
          insertedRows: date.promotedRows,
          observationRows: 1,
          watermark: {
            profileId,
            reportType: report.reportType,
            date: date.reportDate,
            source: date.source,
            reportRequestId,
            requestedAt: report.requestedAt.toISOString(),
            promotedAt: '2026-08-17T02:00:00.000Z',
            sourceRows: date.sourceRows,
            parsedRows: date.parsedRows,
            refusedRows: 0,
            promotedRows: date.promotedRows,
            canonicalRows: date.promotedRows,
          },
        };
      },
      completeReport: async (_id: string, counts: typeof completed[number]) => { completed.push(counts); },
    } satisfies WorkerStore;
    const rows = [targetingRow('kw-1', '2026-08-14'), targetingRow('kw-2', '2026-08-16')];
    const worker = new SyncWorker({
      workerId: 'unit-worker', store, adsApi: new PayloadApi(rows),
      now: () => new Date('2026-08-17T02:00:00Z'),
      buckets: new RegionTokenBuckets(2), logger: { info: () => {}, error: () => {} },
    });

    expect(await worker.drainOnce()).toBe(1);
    expect(promoted.map((date) => [date.reportDate, date.sourceRows, date.promotedRows])).toEqual([
      ['2026-08-14', 1, 1],
      ['2026-08-15', 0, 0],
      ['2026-08-16', 1, 1],
    ]);
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({ parsed: 2, loaded: 2 });
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({
      outcome: 'succeeded',
      result: {
        reportRows: 2,
        parsedSourceRows: 2,
        refusedRows: 0,
        factRows: 2,
        canonicalRows: 2,
        reportDates: 3,
        promotedDates: 3,
        partitionsCreated: 1,
      },
    });
  });

  it('re-polls an expired download URL only while the report request is recoverable', async () => {
    const now = new Date('2026-08-17T04:00:00Z');
    const report: ReportRequestState = {
      id: reportRequestId, orgId, profileId, reportType: 'spTargeting',
      startDate: '2026-08-14', endDate: '2026-08-14', source: 'amazon_api',
      amazonReportId: 'amazon-report', requestedAt: new Date('2026-08-17T01:00:01Z'),
      pollAttempts: 3,
    };
    const enqueued: { payload: JobPayload; dedupeKey: string }[] = [];
    const outcomes: { outcome: JobOutcome; result: unknown }[] = [];
    let claimed = false;
    const store = {
      ...stubStore(),
      claim: async () => claimed ? [] : (claimed = true, [{
        id: jobId, orgId, profileId, jobType: payload.type, payload,
        attempts: 1, maxAttempts: 5, dedupeKey: null, claim: null, claimedBy: 'unit-worker',
      }]),
      finish: async (_id: string, outcome: JobOutcome, options?: { result?: unknown }) => {
        outcomes.push({ outcome, result: options?.result });
      },
      getReportRequest: async () => report,
      enqueue: async (nextPayload: JobPayload, _runAt: Date, dedupeKey: string) => {
        enqueued.push({ payload: nextPayload, dedupeKey });
        return true;
      },
    } satisfies WorkerStore;
    const worker = new SyncWorker({
      workerId: 'unit-worker', store, adsApi: new ExpiredDownloadApi(), now: () => now,
      buckets: new RegionTokenBuckets(2), logger: { info: () => {}, error: () => {} },
    });

    expect(await worker.drainOnce()).toBe(1);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]).toMatchObject({
      payload: { type: 'report.poll', reportRequestId, amazonReportId: 'amazon-report', attempt: 3 },
      dedupeKey: `report.repoll:${reportRequestId}:3`,
    });
    expect(outcomes).toEqual([{
      outcome: 'succeeded',
      result: { downloadExpired: true, repollEnqueued: true },
    }]);
  });

  it('fails the ledger and dead-letters an expired URL beyond the request horizon', async () => {
    const now = new Date('2026-08-17T05:00:00Z');
    const report: ReportRequestState = {
      id: reportRequestId, orgId, profileId, reportType: 'spTargeting',
      startDate: '2026-08-14', endDate: '2026-08-14', source: 'amazon_api',
      amazonReportId: 'amazon-report', requestedAt: new Date('2026-08-17T01:00:00Z'),
      pollAttempts: 3,
    };
    const failed: string[] = [];
    const dead: string[] = [];
    let claimed = false;
    const store = {
      ...stubStore(),
      claim: async () => claimed ? [] : (claimed = true, [{
        id: jobId, orgId, profileId, jobType: payload.type, payload,
        attempts: 1, maxAttempts: 5, dedupeKey: null, claim: null, claimedBy: 'unit-worker',
      }]),
      getReportRequest: async () => report,
      failReport: async (_id: string, error: string) => { failed.push(error); },
      deadLetter: async (_id: string, error: string) => { dead.push(error); },
    } satisfies WorkerStore;
    const worker = new SyncWorker({
      workerId: 'unit-worker', store, adsApi: new ExpiredDownloadApi(), now: () => now,
      buckets: new RegionTokenBuckets(2), logger: { info: () => {}, error: () => {} },
    });

    expect(await worker.drainOnce()).toBe(1);
    expect(failed).toEqual(['report download URL remained expired beyond the 4-hour request horizon']);
    expect(dead).toEqual(['report download URL remained expired beyond the 4-hour request horizon']);
  });
});

describe('crosscheck.ingest retry policy', () => {
  const payload: Extract<JobPayload, { type: 'crosscheck.ingest' }> = {
    type: 'crosscheck.ingest', orgId, profileId, date: '2026-08-13', sourcePath: 'inbox/profile-1',
  };

  function run(thrown?: Error) {
    const job: ClaimedJob = {
      id: jobId, orgId, profileId, jobType: payload.type, payload,
      attempts: 1, maxAttempts: 5, dedupeKey: null, claim: null, claimedBy: 'unit-worker',
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
      attempts: 1, maxAttempts: 5, dedupeKey: null, claim: null, claimedBy: 'unit-worker',
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
      attempts: 1, maxAttempts: 5, dedupeKey: null, claim: null, claimedBy: 'unit-worker',
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
      recommendationsRun: async (incoming, execution) => {
        expect(execution).toEqual({ jobId });
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
      attempts: 1, maxAttempts: 5, dedupeKey: null, claim: null, claimedBy: 'unit-worker',
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

  it('dead-letters immutable scope corruption without spending the retry budget', async () => {
    const job: ClaimedJob = {
      id: jobId, orgId, profileId, jobType: payload.type, payload,
      attempts: 1, maxAttempts: 5, dedupeKey: null, claim: null, claimedBy: 'unit-worker',
    };
    let claimed = false;
    const dead: string[] = [];
    const retried: string[] = [];
    const worker = new SyncWorker({
      workerId: 'unit-worker', adsApi: new OneRowApi(),
      buckets: new RegionTokenBuckets(2), logger: { info: () => {}, error: () => {} },
      store: {
        ...stubStore(),
        claim: async () => claimed ? [] : (claimed = true, [job]),
        deadLetter: async (_id, error) => { dead.push(error); },
        finish: async (_id, outcome) => { retried.push(outcome); },
      },
      recommendationsRun: async () => {
        throw new RecommendationScopeIntegrityError();
      },
    });

    expect(await worker.drainOnce()).toBe(1);
    expect(dead).toEqual(['Recommendation preview evidence failed its integrity check.']);
    expect(retried).toEqual([]);
  });

  it('dead-letters an executing job without exact run custody', async () => {
    const job: ClaimedJob = {
      id: jobId, orgId, profileId, jobType: payload.type, payload,
      attempts: 1, maxAttempts: 5, dedupeKey: null, claim: null, claimedBy: 'unit-worker',
    };
    let claimed = false;
    const dead: string[] = [];
    const retried: string[] = [];
    const worker = new SyncWorker({
      workerId: 'unit-worker', adsApi: new OneRowApi(),
      buckets: new RegionTokenBuckets(2), logger: { info: () => {}, error: () => {} },
      store: {
        ...stubStore(),
        claim: async () => claimed ? [] : (claimed = true, [job]),
        deadLetter: async (_id, error) => { dead.push(error); },
        finish: async (_id, outcome) => { retried.push(outcome); },
      },
      recommendationsRun: async () => {
        throw new RecommendationExecutionCustodyError();
      },
    });

    expect(await worker.drainOnce()).toBe(1);
    expect(dead).toEqual(['Recommendation execution does not own the linked queue job.']);
    expect(retried).toEqual([]);
  });
});

describe('integration handler wiring', () => {
  const payloads: JobPayload[] = [
    { type: 'keepa.sync', orgId, profileId, includeCompetitors: true },
    { type: 'rank.sync', orgId, profileId },
    { type: 'economics.sync', orgId, profileId },
    { type: 'sqp.categorize', orgId, profileId, weekStart: '2026-08-23' },
    {
      type: 'creative.sync', orgId, profileId, adProduct: 'SB',
      startDate: '2026-08-01', endDate: '2026-08-23',
    },
    {
      type: 'sqp.request', orgId, profileId, marketplaceId: 'marketplace-one',
      asins: ['B000000001'], weekStart: '2026-08-16', weekEnd: '2026-08-22',
    },
    {
      type: 'history.bootstrap', orgId, profileId, reportType: 'sbAds',
      source: 'amazon_unified_reporting', cursorDate: null,
    },
    {
      type: 'report.promote', orgId, profileId, reportRequestId,
      reportType: 'sbAds', date: '2026-08-23',
    },
    { type: 'marketing_stream.normalize', orgId, profileId, messageIds: ['message-one'] },
  ];

  it('delegates every queue payload only through an explicitly bound handler', async () => {
    let claimed = false;
    const called: string[] = [];
    const sqpJobIds: string[] = [];
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
      claim: null, claimedBy: 'integration-worker',
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
        creativeSync: async (payload) => (called.push(payload.type), { rows: 1 }),
        sqpRequest: async (payload, context) => (
          called.push(payload.type), sqpJobIds.push(context.jobId), { asins: payload.asins.length }
        ),
        historyBootstrap: async (payload) => (called.push(payload.type), { source: payload.source }),
        reportPromote: async (payload) => (called.push(payload.type), { date: payload.date }),
        marketingStreamNormalize: async (payload) => (
          called.push(payload.type), { messages: payload.messageIds.length }
        ),
      },
      logger: { info: () => {}, error: () => {} },
    });

    expect(await worker.drainOnce()).toBe(payloads.length);
    expect(called).toEqual(payloads.map((payload) => payload.type));
    expect(results).toHaveLength(payloads.length);
    expect(sqpJobIds).toEqual([jobs[5]?.id]);
  });

  it('dead-letters an approved feature payload when its real handler is absent', async () => {
    const payload = payloads.at(-1);
    if (!payload || payload.type !== 'marketing_stream.normalize') {
      throw new Error('missing Marketing Stream payload');
    }
    let claimed = false;
    const dead: string[] = [];
    const worker = new SyncWorker({
      workerId: 'integration-worker',
      store: {
        ...stubStore(),
        claim: async () => claimed ? [] : (claimed = true, [{
          id: jobId, orgId, profileId, jobType: payload.type, payload,
          attempts: 1, maxAttempts: 5, dedupeKey: null, claim: null, claimedBy: 'integration-worker',
        }]),
        deadLetter: async (_id, error) => { dead.push(error); },
      },
      logger: { info: () => {}, error: () => {} },
    });

    expect(await worker.drainOnce()).toBe(1);
    expect(dead).toEqual(['marketing_stream.normalize handler not deployed in this runtime']);
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
          attempts: 1, maxAttempts: 5, dedupeKey: null, claim: null, claimedBy: 'integration-worker',
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
          attempts: 1, maxAttempts: 5, dedupeKey: null, claim: null, claimedBy: 'integration-worker',
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

  it('requeues a pending SQP report with the workflow poll delay', async () => {
    const payload = payloads[5];
    if (!payload || payload.type !== 'sqp.request') throw new Error('missing SQP payload');
    let claimed = false;
    const finishes: { outcome: JobOutcome; retryIn: string | undefined }[] = [];
    const deferrals: string[] = [];
    const worker = new SyncWorker({
      workerId: 'integration-worker',
      store: {
        ...stubStore(),
        claim: async () => claimed ? [] : (claimed = true, [{
          id: jobId, orgId, profileId, jobType: payload.type, payload,
          attempts: 1, maxAttempts: 5, dedupeKey: null, claim: null, claimedBy: 'integration-worker',
        }]),
        finish: async (_id, outcome, options) => {
          finishes.push({ outcome, retryIn: options?.retryIn });
        },
        defer: async (_id, retryIn) => {
          deferrals.push(retryIn);
        },
      },
      integrations: {
        sqpRequest: async () => { throw new SqpWorkflowPendingError(211); },
      },
      logger: { info: () => {}, error: () => {} },
    });

    expect(await worker.drainOnce()).toBe(1);
    expect(finishes).toEqual([]);
    expect(deferrals).toEqual(['211 seconds']);
  });

  it.each([
    { status: 400, expected: 'dead' as const },
    { status: 503, expected: 'failed' as const },
  ])('classifies SP-API auth status $status as $expected', async ({ status, expected }) => {
    const payload = payloads[5];
    if (!payload || payload.type !== 'sqp.request') throw new Error('missing SQP payload');
    let claimed = false;
    const outcomes: JobOutcome[] = [];
    const dead: string[] = [];
    const worker = new SyncWorker({
      workerId: 'integration-worker',
      store: {
        ...stubStore(),
        claim: async () => claimed ? [] : (claimed = true, [{
          id: jobId, orgId, profileId, jobType: payload.type, payload,
          attempts: 1, maxAttempts: 5, dedupeKey: null, claim: null, claimedBy: 'integration-worker',
        }]),
        finish: async (_id, outcome) => { outcomes.push(outcome); },
        deadLetter: async (_id, error) => { dead.push(error); },
      },
      integrations: {
        sqpRequest: async () => { throw new SpApiAuthError('SP-API authorization failed', status); },
      },
      logger: { info: () => {}, error: () => {} },
    });

    expect(await worker.drainOnce()).toBe(1);
    if (expected === 'dead') {
      expect(dead).toEqual(['SP-API authorization failed']);
      expect(outcomes).toEqual([]);
    } else {
      expect(dead).toEqual([]);
      expect(outcomes).toEqual(['failed']);
    }
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

describe('Reporting v3 create ambiguity', () => {
  it('quarantines the request without a retry or poll admission', async () => {
    const payload: Extract<JobPayload, { type: 'report.request' }> = {
      type: 'report.request',
      orgId,
      profileId,
      reportType: 'spCampaigns',
      startDate: '2026-08-29',
      endDate: '2026-08-29',
    };
    const job: ClaimedJob = {
      id: jobId,
      orgId,
      profileId,
      jobType: payload.type,
      payload,
      attempts: 1,
      maxAttempts: 5,
      dedupeKey: null,
      claim: null, claimedBy: 'ambiguous-create-worker',
    };
    let claimed = false;
    const finishes: JobOutcome[] = [];
    const dead: string[] = [];
    const terminal: string[] = [];
    let pollAdmissions = 0;
    const store: WorkerStore = {
      ...stubStore(),
      claim: async () => claimed ? [] : (claimed = true, [job]),
      ensureReportRequest: async () => ({
        id: jobId,
        orgId,
        profileId,
        reportType: payload.reportType,
        startDate: payload.startDate,
        endDate: payload.endDate,
        source: 'amazon_api',
        amazonReportId: null,
        requestedAt: new Date('2026-08-29T00:00:00.000Z'),
        pollAttempts: 0,
      }),
      finish: async (_id, outcome) => { finishes.push(outcome); },
      deadLetter: async (_id, error) => { dead.push(error); },
      failTerminalReport: async (_scope, error) => (terminal.push(error), true),
      enqueue: async () => { pollAdmissions += 1; return true; },
    };
    const api = new AmbiguousCreateApi();
    const worker = new SyncWorker({
      workerId: 'ambiguous-create-worker',
      store,
      adsApi: api,
      logger: { info: () => {}, error: () => {} },
    });

    expect(await worker.drainOnce()).toBe(1);

    expect(api.createCalls).toBe(1);
    expect(finishes).toEqual([]);
    expect(dead).toEqual(['Reporting v3 create outcome is unknown after transport']);
    expect(terminal).toEqual(['report create outcome unknown; attended reconciliation required']);
    expect(pollAdmissions).toBe(0);
  });

  it('continues after a committed provider id loses its database reply', async () => {
    const payload: Extract<JobPayload, { type: 'report.request' }> = {
      type: 'report.request', orgId, profileId, reportType: 'spCampaigns',
      startDate: '2026-08-29', endDate: '2026-08-29',
    };
    const token = '55555555-5555-4555-8555-555555555555' as ClaimToken;
    const job: ClaimedJob = {
      id: jobId, orgId, profileId, jobType: payload.type, payload,
      attempts: 1, maxAttempts: 5, dedupeKey: null, claimedBy: 'evo-report:test',
      claim: { jobId, workerId: 'evo-report:test', token },
    };
    let claimed = false;
    let persisted = false;
    let pollAdmissions = 0;
    const settled: JobOutcome[] = [];
    const store: WorkerStore = {
      ...stubStore(),
      claim: async () => claimed ? [] : (claimed = true, [job]),
      ensureReportRequest: async () => ({
        id: jobId, orgId, profileId, reportType: payload.reportType,
        startDate: payload.startDate, endDate: payload.endDate, source: 'amazon_api',
        amazonReportId: null, requestedAt: new Date(), pollAttempts: 0,
      }),
      setReportCreated: async (input) => {
        expect(input.claim).toEqual(job.claim);
        persisted = true;
        throw new Error('synthetic reply loss after commit');
      },
      confirmReportCreated: async (input) => persisted
        && input.amazonReportId === 'unused'
        && input.claim?.token === token,
      enqueue: async () => (pollAdmissions += 1, true),
      finishClaim: async (_claim, outcome) => { settled.push(outcome); },
    };
    const worker = new SyncWorker({
      workerId: 'evo-report:test', store, adsApi: new OneRowApi(),
      logger: { info: () => {}, error: () => {} },
    });

    await expect(worker.drainOnce()).resolves.toBe(1);
    expect(pollAdmissions).toBe(1);
    expect(settled).toEqual(['succeeded']);
  });

  it.each([
    ['write-refused', false],
    ['readback-unavailable', true],
  ] as const)('quarantines fenced custody when provider-id persistence is %s', async (_case, readbackThrows) => {
    const payload: Extract<JobPayload, { type: 'report.request' }> = {
      type: 'report.request', orgId, profileId, reportType: 'spCampaigns',
      startDate: '2026-08-29', endDate: '2026-08-29',
    };
    const token = '55555555-5555-4555-8555-555555555555' as ClaimToken;
    const job: ClaimedJob = {
      id: jobId, orgId, profileId, jobType: payload.type, payload,
      attempts: 1, maxAttempts: 5, dedupeKey: null, claimedBy: 'evo-report:test',
      claim: { jobId, workerId: 'evo-report:test', token },
    };
    let claimed = false;
    const mutations: string[] = [];
    const store: WorkerStore = {
      ...stubStore(),
      claim: async () => claimed ? [] : (claimed = true, [job]),
      ensureReportRequest: async () => ({
        id: jobId, orgId, profileId, reportType: payload.reportType,
        startDate: payload.startDate, endDate: payload.endDate, source: 'amazon_api',
        amazonReportId: null, requestedAt: new Date(), pollAttempts: 0,
      }),
      setReportCreated: async () => false,
      confirmReportCreated: async () => {
        if (readbackThrows) throw new Error('synthetic readback outage');
        return false;
      },
      enqueue: async () => (mutations.push('enqueue'), true),
      finishClaim: async () => { mutations.push('finish'); },
      deadLetterClaim: async () => { mutations.push('dead'); },
      deferClaim: async () => { mutations.push('defer'); },
      failTerminalReport: async () => (mutations.push('terminal'), true),
    };
    const worker = new SyncWorker({
      workerId: 'evo-report:test', store, adsApi: new OneRowApi(),
      logger: { info: () => {}, error: () => {} },
    });

    await expect(worker.drainOnce()).rejects.toMatchObject({
      name: 'QueueSettlementError', kind: 'custody_quarantined',
    });
    expect(worker.status().settlementFailure).toBe('custody_quarantined');
    expect(mutations).toEqual([]);
    const evidence = await worker.shutdown();
    expect(evidence).toEqual({ released: 0, unresolved: 1 });
    expect(shutdownExitCode(evidence, worker.status().settlementFailure)).toBe(78);
  });
});

describe('fenced report download limits', () => {
  const cases = [
    { kind: 'compressed_bytes' as const, returnCalls: 1, limits: { maxCompressedBytes: 1, maxDecompressedBytes: 4_096, idleTimeoutMs: 1_000, totalTimeoutMs: 5_000 } },
    { kind: 'decompressed_bytes' as const, returnCalls: 0, limits: { maxCompressedBytes: 4_096, maxDecompressedBytes: 2, idleTimeoutMs: 1_000, totalTimeoutMs: 5_000 } },
    { kind: 'idle_timeout' as const, returnCalls: 1, limits: { maxCompressedBytes: 4_096, maxDecompressedBytes: 4_096, idleTimeoutMs: 10, totalTimeoutMs: 1_000 } },
    { kind: 'total_timeout' as const, returnCalls: 1, limits: { maxCompressedBytes: 4_096, maxDecompressedBytes: 4_096, idleTimeoutMs: 1_000, totalTimeoutMs: 10 } },
    { kind: 'sync_cancel_throw' as const, returnCalls: 1, limits: { maxCompressedBytes: 4_096, maxDecompressedBytes: 4_096, idleTimeoutMs: 10, totalTimeoutMs: 1_000 } },
  ] satisfies readonly { kind: string; returnCalls: number; limits: ReportDownloadLimits }[];

  it.each(cases)('cancels the source and retains custody after $kind', async ({ kind, limits, returnCalls }) => {
    const payload: Extract<JobPayload, { type: 'report.fetch' }> = {
      type: 'report.fetch', orgId, profileId, reportRequestId,
      amazonReportId: 'amazon-report', downloadUrl: 'https://reports.invalid/bounded',
    };
    const token = '55555555-5555-4555-8555-555555555555' as ClaimToken;
    const job: ClaimedJob = {
      id: jobId, orgId, profileId, jobType: payload.type, payload,
      attempts: 1, maxAttempts: 5, dedupeKey: null, claimedBy: 'evo-report:test',
      claim: { jobId, workerId: 'evo-report:test', token },
    };
    let claimed = false;
    const mutations: string[] = [];
    const api = new LimitDownloadApi(kind);
    const store: WorkerStore = {
      ...stubStore(),
      claim: async () => claimed ? [] : (claimed = true, [job]),
      getReportRequest: async () => ({
        id: reportRequestId, orgId, profileId, reportType: 'spCampaigns',
        startDate: '2026-08-29', endDate: '2026-08-29', source: 'amazon_api',
        amazonReportId: 'amazon-report', requestedAt: new Date(), pollAttempts: 0,
      }),
      finishClaim: async () => { mutations.push('finish'); },
      deadLetterClaim: async () => { mutations.push('dead'); },
      deferClaim: async () => { mutations.push('defer'); },
      failReport: async () => { mutations.push('fail-report'); },
      failTerminalReport: async () => (mutations.push('terminal'), true),
    };
    const worker = new SyncWorker({
      workerId: 'evo-report:test', store, adsApi: api,
      reportDownloadLimits: limits,
      logger: { info: () => {}, error: () => {} },
    });

    await expect(worker.drainOnce()).rejects.toMatchObject({
      name: 'QueueSettlementError', kind: 'custody_quarantined',
    });
    expect(api.signal?.aborted).toBe(true);
    expect(api.returnCalls).toBe(returnCalls);
    expect(mutations).toEqual([]);
    expect(worker.status().settlementFailure).toBe('custody_quarantined');
    const evidence = await worker.shutdown();
    expect(evidence).toEqual({ released: 0, unresolved: 1 });
    expect(shutdownExitCode(evidence, worker.status().settlementFailure)).toBe(78);
  });
});

describe('Unified Reporting worker isolation', () => {
  it('keeps a successful v3 request successful when sidecar admission fails', async () => {
    const payload: Extract<JobPayload, { type: 'report.request' }> = {
      type: 'report.request',
      orgId,
      profileId,
      reportType: 'spCampaigns',
      startDate: '2026-08-29',
      endDate: '2026-08-29',
    };
    const job: ClaimedJob = {
      id: jobId,
      orgId,
      profileId,
      jobType: payload.type,
      payload,
      attempts: 1,
      maxAttempts: 5,
      dedupeKey: null,
      claim: null, claimedBy: 'unified-isolation-worker',
    };
    let claimed = false;
    let outcome: JobOutcome | undefined;
    let result: unknown;
    const store: WorkerStore = {
      ...stubStore(),
      claim: async () => claimed ? [] : (claimed = true, [job]),
      ensureReportRequest: async () => ({
        id: jobId,
        orgId,
        profileId,
        reportType: 'spCampaigns',
        startDate: payload.startDate,
        endDate: payload.endDate,
        source: 'amazon_api',
        amazonReportId: null,
        requestedAt: new Date('2026-08-29T00:00:00.000Z'),
        pollAttempts: 0,
      }),
      finish: async (_id, nextOutcome, options) => {
        outcome = nextOutcome;
        result = options?.result;
      },
    };
    const unified: UnifiedDualRun = {
      admit: async () => { throw new Error('synthetic sidecar persistence failure'); },
      advance: async () => { throw new Error('unused'); },
      failTerminal: async () => {},
    };
    const worker = new SyncWorker({
      workerId: 'unified-isolation-worker',
      store,
      adsApi: new OneRowApi(),
      unifiedReporting: unified,
      logger: { info: () => {}, error: () => {} },
    });

    expect(await worker.drainOnce()).toBe(1);
    expect(outcome).toBe('succeeded');
    expect(result).toMatchObject({
      reportRequestId: jobId,
      amazonReportId: 'unused',
      pollEnqueued: true,
      unified: { kind: 'local_failed' },
    });
  });

  it.each([
    ['create success', { state: 'observing', disposition: 'provider_success' }],
    ['create refusal', { state: 'create_refused', disposition: 'provider_refused' }],
    ['create ambiguity', { state: 'create_ambiguous', disposition: 'create_ambiguous' }],
    ['retrieve success', { state: 'provider_status_observed', disposition: 'provider_success' }],
    ['retrieve refusal', { state: 'retrieve_refused', disposition: 'provider_refused' }],
    ['retrieve transport failure', { state: 'observing', disposition: 'transport_failure' }],
    ['invalid response', { state: 'contract_blocked', disposition: 'invalid_response' }],
    ['local refusal', { state: 'paused', disposition: 'local_refusal' }],
    ['interrupted retrieve', { state: 'observing', disposition: 'interrupted_dispatch' }],
  ] as const)('keeps the completed v3 job immutable after a later %s', async (_label, sidecarResult) => {
    const v3Payload: Extract<JobPayload, { type: 'report.request' }> = {
      type: 'report.request',
      orgId,
      profileId,
      reportType: 'spCampaigns',
      startDate: '2026-08-29',
      endDate: '2026-08-29',
    };
    const sidecarJobId = '99999999-9999-4999-8999-999999999999';
    const sidecarPayload: Extract<JobPayload, { type: 'report.unified.advance' }> = {
      type: 'report.unified.advance',
      orgId,
      profileId,
      runId: '55555555-5555-4555-8555-555555555555',
      operationId: '66666666-6666-4666-8666-666666666666',
    };
    const jobs: ClaimedJob[] = [
      {
        id: jobId, orgId, profileId, jobType: v3Payload.type, payload: v3Payload,
        attempts: 1, maxAttempts: 5, dedupeKey: null, claim: null, claimedBy: 'unified-matrix-worker',
      },
      {
        id: sidecarJobId, orgId, profileId, jobType: sidecarPayload.type, payload: sidecarPayload,
        attempts: 1, maxAttempts: 5, dedupeKey: null, claim: null, claimedBy: 'unified-matrix-worker',
      },
    ];
    const finishes = new Map<string, Array<{ outcome: JobOutcome; result: unknown }>>();
    const store: WorkerStore = {
      ...stubStore(),
      claim: async () => {
        const next = jobs.shift();
        return next ? [next] : [];
      },
      ensureReportRequest: async () => ({
        id: jobId,
        orgId,
        profileId,
        reportType: 'spCampaigns',
        startDate: v3Payload.startDate,
        endDate: v3Payload.endDate,
        source: 'amazon_api',
        amazonReportId: null,
        requestedAt: new Date('2026-08-29T00:00:00.000Z'),
        pollAttempts: 0,
      }),
      finish: async (id, outcome, options) => {
        finishes.set(id, [
          ...(finishes.get(id) ?? []),
          { outcome, result: options?.result },
        ]);
      },
    };
    const unified: UnifiedDualRun = {
      admit: async () => ({
        kind: 'enqueued',
        runId: sidecarPayload.runId,
        operationId: sidecarPayload.operationId,
        inserted: true,
      }),
      advance: async () => ({ ...sidecarResult }),
      failTerminal: async () => {},
    };
    const worker = new SyncWorker({
      workerId: 'unified-matrix-worker',
      store,
      adsApi: new OneRowApi(),
      unifiedReporting: unified,
      logger: { info: () => {}, error: () => {} },
    });

    expect(await worker.drainOnce(1)).toBe(1);
    const completedV3 = structuredClone(finishes.get(jobId));
    expect(completedV3).toEqual([{
      outcome: 'succeeded',
      result: expect.objectContaining({
        reportRequestId: jobId,
        amazonReportId: 'unused',
        pollEnqueued: true,
        unified: expect.objectContaining({ kind: 'enqueued' }),
      }),
    }]);

    expect(await worker.drainOnce(1)).toBe(1);
    expect(finishes.get(sidecarJobId)).toEqual([{
      outcome: 'succeeded',
      result: sidecarResult,
    }]);
    expect(finishes.get(jobId)).toEqual(completedV3);
  });

  it('keeps the completed v3 job immutable when later sidecar persistence fails', async () => {
    const v3Payload: Extract<JobPayload, { type: 'report.request' }> = {
      type: 'report.request', orgId, profileId, reportType: 'spCampaigns',
      startDate: '2026-08-29', endDate: '2026-08-29',
    };
    const sidecarJobId = '99999999-9999-4999-8999-999999999999';
    const sidecarPayload: Extract<JobPayload, { type: 'report.unified.advance' }> = {
      type: 'report.unified.advance', orgId, profileId,
      runId: '55555555-5555-4555-8555-555555555555',
      operationId: '66666666-6666-4666-8666-666666666666',
    };
    const jobs: ClaimedJob[] = [
      {
        id: jobId, orgId, profileId, jobType: v3Payload.type, payload: v3Payload,
        attempts: 1, maxAttempts: 5, dedupeKey: null, claim: null, claimedBy: 'unified-failure-worker',
      },
      {
        id: sidecarJobId, orgId, profileId, jobType: sidecarPayload.type, payload: sidecarPayload,
        attempts: 1, maxAttempts: 5, dedupeKey: null, claim: null, claimedBy: 'unified-failure-worker',
      },
    ];
    const outcomes = new Map<string, JobOutcome[]>();
    const store: WorkerStore = {
      ...stubStore(),
      claim: async () => {
        const next = jobs.shift();
        return next ? [next] : [];
      },
      ensureReportRequest: async () => ({
        id: jobId, orgId, profileId, reportType: 'spCampaigns',
        startDate: v3Payload.startDate, endDate: v3Payload.endDate,
        source: 'amazon_api', amazonReportId: null,
        requestedAt: new Date('2026-08-29T00:00:00.000Z'), pollAttempts: 0,
      }),
      finish: async (id, outcome) => {
        outcomes.set(id, [...(outcomes.get(id) ?? []), outcome]);
      },
    };
    const unified: UnifiedDualRun = {
      admit: async () => ({
        kind: 'enqueued', runId: sidecarPayload.runId,
        operationId: sidecarPayload.operationId, inserted: true,
      }),
      advance: async () => { throw new Error('synthetic sidecar persistence failure'); },
      failTerminal: async () => {},
    };
    const worker = new SyncWorker({
      workerId: 'unified-failure-worker', store, adsApi: new OneRowApi(),
      unifiedReporting: unified, logger: { info: () => {}, error: () => {} },
    });

    expect(await worker.drainOnce(1)).toBe(1);
    expect(outcomes.get(jobId)).toEqual(['succeeded']);
    expect(await worker.drainOnce(1)).toBe(1);
    expect(outcomes.get(sidecarJobId)).toEqual(['failed']);
    expect(outcomes.get(jobId)).toEqual(['succeeded']);
  });

  it('closes a sidecar operation when its own retry budget is exhausted', async () => {
    const runId = '55555555-5555-4555-8555-555555555555';
    const operationId = '66666666-6666-4666-8666-666666666666';
    const payload: Extract<JobPayload, { type: 'report.unified.advance' }> = {
      type: 'report.unified.advance', orgId, profileId, runId, operationId,
    };
    const job: ClaimedJob = {
      id: jobId,
      orgId,
      profileId,
      jobType: payload.type,
      payload,
      attempts: 5,
      maxAttempts: 5,
      dedupeKey: null,
      claim: null, claimedBy: 'unified-terminal-worker',
    };
    let claimed = false;
    const terminal: Array<{ payload: typeof payload; reason: string }> = [];
    const unified: UnifiedDualRun = {
      admit: async () => ({ kind: 'disabled' }),
      advance: async () => { throw new Error('synthetic sidecar store failure'); },
      failTerminal: async (failedPayload, reason) => {
        terminal.push({ payload: failedPayload, reason });
      },
    };
    const worker = new SyncWorker({
      workerId: 'unified-terminal-worker',
      store: {
        ...stubStore(),
        claim: async () => claimed ? [] : (claimed = true, [job]),
      },
      unifiedReporting: unified,
      logger: { info: () => {}, error: () => {} },
    });

    expect(await worker.drainOnce()).toBe(1);
    expect(terminal).toEqual([{
      payload,
      reason: 'report lifecycle stopped after exhausting its retry budget',
    }]);
  });
});

describe('terminal report lifecycle invariant', () => {
  const cases = [
    {
      phase: 'request' as const,
      payload: {
        type: 'report.request' as const,
        orgId,
        profileId,
        reportType: 'spCampaigns' as const,
        startDate: '2026-08-29',
        endDate: '2026-08-29',
      },
      expectedReportRequestId: jobId,
    },
    {
      phase: 'poll' as const,
      payload: {
        type: 'report.poll' as const,
        orgId,
        profileId,
        reportRequestId,
        amazonReportId: 'amazon-report',
        attempt: 0,
      },
      expectedReportRequestId: reportRequestId,
    },
    {
      phase: 'fetch' as const,
      payload: {
        type: 'report.fetch' as const,
        orgId,
        profileId,
        reportRequestId,
        amazonReportId: 'amazon-report',
        downloadUrl: 'https://reports.invalid/terminal',
      },
      expectedReportRequestId: reportRequestId,
    },
  ];

  it.each(cases)('fails the tenant-scoped ledger when $phase exhausts retries', async (testCase) => {
    const job: ClaimedJob = {
      id: jobId,
      orgId,
      profileId,
      jobType: testCase.payload.type,
      payload: testCase.payload,
      attempts: 5,
      maxAttempts: 5,
      dedupeKey: null,
      claim: null, claimedBy: 'terminal-worker',
    };
    let claimed = false;
    const terminalCalls: Array<{
      scope: { reportRequestId: string; orgId: string; profileId: string };
      error: string;
    }> = [];
    const report: ReportRequestState = {
      id: testCase.expectedReportRequestId,
      orgId,
      profileId,
      reportType: 'spCampaigns',
      startDate: '2026-08-29',
      endDate: '2026-08-29',
      source: 'amazon_api',
      amazonReportId: testCase.phase === 'request' ? null : 'amazon-report',
      requestedAt: new Date('2026-08-29T00:00:00Z'),
      pollAttempts: 0,
    };
    const store: WorkerStore = {
      ...stubStore(),
      claim: async () => claimed ? [] : (claimed = true, [job]),
      ensureReportRequest: async () => report,
      getReportRequest: async () => report,
      failTerminalReport: async (scope, error) => {
        terminalCalls.push({ scope, error });
        return true;
      },
    };
    const worker = new SyncWorker({
      workerId: 'terminal-worker',
      store,
      adsApi: new TerminalPhaseFailureApi(testCase.phase),
      buckets: new RegionTokenBuckets(2),
      logger: { info: () => {}, error: () => {} },
    });

    expect(await worker.drainOnce()).toBe(1);
    expect(terminalCalls).toEqual([{
      scope: { reportRequestId: testCase.expectedReportRequestId, orgId, profileId },
      error: 'report lifecycle stopped after exhausting its retry budget',
    }]);
  });

  it('keeps an unfinished retryable report pending while attempts remain', async () => {
    const payload: Extract<JobPayload, { type: 'report.fetch' }> = {
      type: 'report.fetch',
      orgId,
      profileId,
      reportRequestId,
      amazonReportId: 'amazon-report',
      downloadUrl: 'https://reports.invalid/retry',
    };
    const job: ClaimedJob = {
      id: jobId,
      orgId,
      profileId,
      jobType: payload.type,
      payload,
      attempts: 1,
      maxAttempts: 5,
      dedupeKey: null,
      claim: null, claimedBy: 'retry-worker',
    };
    let claimed = false;
    let terminalCalls = 0;
    const store: WorkerStore = {
      ...stubStore(),
      claim: async () => claimed ? [] : (claimed = true, [job]),
      getReportRequest: async () => ({
        id: reportRequestId,
        orgId,
        profileId,
        reportType: 'spCampaigns',
        startDate: '2026-08-29',
        endDate: '2026-08-29',
        source: 'amazon_api',
        amazonReportId: 'amazon-report',
        requestedAt: new Date('2026-08-29T00:00:00Z'),
        pollAttempts: 0,
      }),
      failTerminalReport: async () => (terminalCalls += 1, true),
    };
    const worker = new SyncWorker({
      workerId: 'retry-worker',
      store,
      adsApi: new TerminalPhaseFailureApi('fetch'),
      buckets: new RegionTokenBuckets(2),
      logger: { info: () => {}, error: () => {} },
    });

    expect(await worker.drainOnce()).toBe(1);
    expect(terminalCalls).toBe(0);
  });

  it('does not block a successful report ledger and stops on queue finalization failure', async () => {
    const payload: Extract<JobPayload, { type: 'report.poll' }> = {
      type: 'report.poll',
      orgId,
      profileId,
      reportRequestId,
      amazonReportId: 'amazon-report',
      attempt: 0,
    };
    const job: ClaimedJob = {
      id: jobId,
      orgId,
      profileId,
      jobType: payload.type,
      payload,
      attempts: 5,
      maxAttempts: 5,
      dedupeKey: null,
      claim: null, claimedBy: 'finalization-worker',
    };
    let claimed = false;
    let terminalCalls = 0;
    let finishCalls = 0;
    const store: WorkerStore = {
      ...stubStore(),
      claim: async () => claimed ? [] : (claimed = true, [job]),
      getReportRequest: async () => ({
        id: reportRequestId,
        orgId,
        profileId,
        reportType: 'spCampaigns',
        startDate: '2026-08-29',
        endDate: '2026-08-29',
        source: 'amazon_api',
        amazonReportId: 'amazon-report',
        requestedAt: new Date(),
        pollAttempts: 0,
      }),
      finish: async () => {
        finishCalls += 1;
        throw new Error('synthetic queue finalization failure');
      },
      failTerminalReport: async () => (terminalCalls += 1, true),
    };
    const worker = new SyncWorker({
      workerId: 'finalization-worker',
      store,
      adsApi: new OneRowApi(),
      buckets: new RegionTokenBuckets(2),
      logger: { info: () => {}, error: () => {} },
    });

    await expect(worker.drainOnce()).rejects.toMatchObject({
      name: 'QueueSettlementError',
      kind: 'unavailable',
    });
    expect(finishCalls).toBe(1);
    expect(terminalCalls).toBe(0);
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
    setReportCreated: async () => true,
    confirmReportCreated: async () => true,
    getReportRequest: async () => { throw new Error('unused'); },
    updateReportPoll: async () => {},
    enqueue: async () => true,
    ensureReportPartitions: async () => ({ expectedMonths: 0, matchedMonths: 0, createdMonths: 0 }),
    promoteReportDate: async () => { throw new Error('unused'); },
    failReport: async () => {},
    failTerminalReport: async () => false,
    loadFacts: async () => 0,
    completeReport: async () => {},
    finishAttributedReport: async () => {},
  };
}

/** A synthetic `spTargeting` row in the shape Amazon sends: `keywordId`, no `targetId`. */
function targetingRow(keywordId: string, date = '2026-08-14'): Record<string, unknown> {
  return {
    date, campaignId: 'c-1', adGroupId: 'ag-1', keywordId,
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
  async downloadReport(_url?: string, _signal?: AbortSignal): Promise<AsyncIterable<Uint8Array>> {
    const bytes = gzipSync(JSON.stringify([{ date: '2026-08-14', campaignId: 'c-1', impressions: 1, clicks: 1, cost: 1 }]));
    return (async function* stream() { yield bytes; })();
  }
  async listProfiles(_region: Region) { return []; }
}

class AmbiguousCreateApi extends OneRowApi {
  createCalls = 0;

  override async createReport(): Promise<{ reportId: string }> {
    this.createCalls += 1;
    throw new ReportCreateOutcomeUnknownError('transport', null);
  }
}

class ExpiredDownloadApi extends OneRowApi {
  override async downloadReport(): Promise<AsyncIterable<Uint8Array>> {
    throw new DownloadUrlExpiredError('synthetic expired URL');
  }
}

class LimitDownloadApi extends OneRowApi {
  signal: AbortSignal | undefined;
  returnCalls = 0;

  constructor(private readonly limitKind:
    | 'compressed_bytes'
    | 'decompressed_bytes'
    | 'idle_timeout'
    | 'total_timeout'
    | 'sync_cancel_throw') {
    super();
  }

  override async downloadReport(
    _url?: string,
    signal?: AbortSignal,
  ): Promise<AsyncIterable<Uint8Array>> {
    this.signal = signal;
    const compressed = gzipSync(JSON.stringify([{ row: 'bounded-source' }]));
    let delivered = false;
    return {
      [Symbol.asyncIterator]: () => ({
        next: () => {
          if (
            this.limitKind === 'idle_timeout'
            || this.limitKind === 'total_timeout'
            || this.limitKind === 'sync_cancel_throw'
          ) {
            return new Promise<IteratorResult<Uint8Array>>(() => undefined);
          }
          if (delivered) return Promise.resolve({ done: true, value: undefined });
          delivered = true;
          return Promise.resolve({ done: false, value: compressed });
        },
        return: () => {
          this.returnCalls += 1;
          if (this.limitKind === 'sync_cancel_throw') {
            throw new Error('synthetic synchronous source cancellation failure');
          }
          return Promise.resolve({ done: true, value: undefined });
        },
      }),
    };
  }
}

class TerminalPhaseFailureApi extends OneRowApi {
  constructor(private readonly phase: 'request' | 'poll' | 'fetch') {
    super();
  }

  override async createReport(input: CreateReportInput): Promise<{ reportId: string }> {
    if (this.phase === 'request') throw new Error('synthetic request failure');
    return super.createReport(input);
  }

  override async getReport(
    profile: AdsProfileContext,
    reportId: string,
  ): Promise<AdsReportStatus> {
    if (this.phase === 'poll') throw new Error('synthetic poll failure');
    return super.getReport(profile, reportId);
  }

  override async downloadReport(): Promise<AsyncIterable<Uint8Array>> {
    if (this.phase === 'fetch') throw new Error('synthetic fetch failure');
    return super.downloadReport();
  }
}

function profile(): AdsProfileContext {
  return { id: profileId, orgId, amazonProfileId: 'profile-1', region: 'NA', currencyCode: 'USD', timezone: 'UTC' };
}
