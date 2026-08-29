import { describe, expect, it } from 'vitest';
import { completedSqpWeek, PostgresWeeklySqpScheduler } from './sqp-scheduler.js';
import type { SqpRequestJob } from '@wizard-ads/shared';

describe('completedSqpWeek', () => {
  it('selects yesterday-ended week on Sunday and the prior week on Saturday', () => {
    expect(completedSqpWeek('Asia/Bangkok', new Date('2026-08-29T20:00:00Z'))).toEqual({
      weekStart: '2026-08-23',
      weekEnd: '2026-08-29',
    });
    expect(completedSqpWeek('Asia/Bangkok', new Date('2026-08-29T04:00:00Z'))).toEqual({
      weekStart: '2026-08-16',
      weekEnd: '2026-08-22',
    });
  });

  it('uses the profile calendar across a daylight-saving boundary', () => {
    expect(completedSqpWeek('America/New_York', new Date('2026-03-08T16:00:00Z'))).toEqual({
      weekStart: '2026-03-01',
      weekEnd: '2026-03-07',
    });
  });

  it('fails closed on an invalid timezone', () => {
    expect(() => completedSqpWeek('Not/A-Timezone', new Date('2026-08-29T00:00:00Z')))
      .toThrow(/time zone/i);
  });
});

describe('PostgresWeeklySqpScheduler', () => {
  it('reconciles every ASIN row and produces one stable weekly queue identity', async () => {
    const rows = [
      {
        org_id: '00000000-0000-4000-8000-000000000001',
        profile_id: '00000000-0000-4000-8000-000000000011',
        connection_id: '00000000-0000-4000-8000-000000000021',
        marketplace_id: 'synthetic-marketplace',
        region: 'NA',
        timezone: 'UTC',
        asins: ['B000000001'],
        source_rows: '4',
        valid_rows: '2',
        refused_rows: '2',
      },
      {
        org_id: '00000000-0000-4000-8000-000000000001',
        profile_id: '00000000-0000-4000-8000-000000000012',
        connection_id: '00000000-0000-4000-8000-000000000022',
        marketplace_id: 'empty-marketplace',
        region: 'EU',
        timezone: 'UTC',
        asins: [],
        source_rows: '0',
        valid_rows: '0',
        refused_rows: '0',
      },
      {
        org_id: '00000000-0000-4000-8000-000000000001',
        profile_id: '00000000-0000-4000-8000-000000000013',
        connection_id: '00000000-0000-4000-8000-000000000023',
        marketplace_id: 'invalid-timezone-marketplace',
        region: 'FE',
        timezone: 'Invalid/Timezone',
        asins: ['B000000002'],
        source_rows: '1',
        valid_rows: '1',
        refused_rows: '0',
      },
    ];
    const sql = async () => rows;
    const seen = new Set<string>();
    const offered: Array<{ payload: SqpRequestJob; dedupeKey: string }> = [];
    const jobs = {
      enqueue: async (payload: SqpRequestJob, _runAt: Date, dedupeKey: string) => {
        offered.push({ payload, dedupeKey });
        if (seen.has(dedupeKey)) return false;
        seen.add(dedupeKey);
        return true;
      },
    };
    const scheduler = new PostgresWeeklySqpScheduler(
      { sql } as never,
      jobs,
      () => new Date('2026-08-30T12:00:00Z'),
    );

    await expect(scheduler.enqueueDueSqpRequests()).resolves.toEqual({
      scopes: 3,
      scopesWithAsins: 1,
      scopesWithoutAsins: 1,
      refusedScopes: 1,
      sourceAsinRows: 5,
      uniqueAsins: 2,
      duplicateAsinRows: 1,
      refusedAsinRows: 2,
      offeredJobs: 1,
      enqueuedJobs: 1,
      alreadyPresentJobs: 0,
    });
    await expect(scheduler.enqueueDueSqpRequests()).resolves.toMatchObject({
      offeredJobs: 1,
      enqueuedJobs: 0,
      alreadyPresentJobs: 1,
    });
    expect(new Set(offered.map((row) => row.dedupeKey))).toEqual(new Set([
      'sqp.request:00000000-0000-4000-8000-000000000011:synthetic-marketplace:2026-08-23',
    ]));
    expect(offered[0]?.payload).toMatchObject({
      type: 'sqp.request',
      marketplaceId: 'synthetic-marketplace',
      asins: ['B000000001'],
      weekStart: '2026-08-23',
      weekEnd: '2026-08-29',
    });
  });
});
