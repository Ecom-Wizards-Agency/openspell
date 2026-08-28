import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  InvalidReportDatePromotion,
  StaleReportDatePromotion,
  promoteReportDate,
  stageReportDate,
  type ReportDatePromotionInput,
} from './queries/report-promotion.js';
import { createTestDatabase, databaseAvailable } from './testing/harness.js';
import type { TestDatabase } from './testing/harness.js';

const available = await databaseAvailable();
const OWNER = '57575757-5757-4757-8757-575757575757';
const FIRST_REQUEST = '58585858-5858-4858-8858-585858585858';
const SECOND_REQUEST = '59595959-5959-4959-8959-595959595959';
const STALE_REQUEST = '60606060-6060-4060-8060-606060606060';

describe('report-date staging', () => {
  const base = {
    orgId: '61616161-6161-4161-8161-616161616161',
    profileId: '62626262-6262-4262-8262-626262626262',
    reportType: 'spTargeting' as const,
    reportDate: '2026-08-01',
    source: 'amazon_reporting_v3' as const,
    reportRequestId: FIRST_REQUEST,
    requestedAt: new Date('2026-08-02T01:00:00Z'),
    observedAt: new Date('2026-08-02T02:00:00Z'),
    sourceRows: 1,
    parsedRows: 1,
    refusedRows: 0,
    attribution: { attributionWindowDays: 7, eventDateAgeDays: 1 },
  };

  it('accounts for every input and derives attribution metrics from promoted rows', () => {
    const staged = stageReportDate({
      ...base,
      batch: {
        kind: 'sp_target',
        rows: [targetFact(base, 'target-1', 3, 24)],
      },
    });
    expect(staged.promotedRows).toBe(1);
    expect(staged.observation).toEqual({
      adProduct: 'SP',
      impressions: 100,
      clicks: 10,
      cost: 12,
      purchases: 3,
      sales: 24,
    });
  });

  it('refuses unreconciled counts, mixed dates, and report-kind mismatches', () => {
    expect(() => stageReportDate({
      ...base,
      sourceRows: 2,
      batch: { kind: 'sp_target', rows: [targetFact(base, 'target-1', 1, 8)] },
    })).toThrow(/source rows do not reconcile/);

    expect(() => stageReportDate({
      ...base,
      sourceRows: 2,
      parsedRows: 2,
      batch: { kind: 'sp_target', rows: [targetFact(base, 'target-1', 1, 8)] },
    })).toThrow(/one-to-one grain/);

    expect(() => stageReportDate({
      ...base,
      batch: {
        kind: 'sp_target',
        rows: [{ ...targetFact(base, 'target-1', 1, 8), date: '2026-08-02' }],
      },
    })).toThrow(/belongs to 2026-08-02/);

    expect(() => stageReportDate({
      ...base,
      batch: {
        kind: 'placement',
        rows: [],
      },
    })).toThrow(InvalidReportDatePromotion);
  });
});

describe.skipIf(!available)('transactional report-date promotion', () => {
  let database: TestDatabase;
  let orgId: string;
  let profileId: string;
  const reportDate = new Date().toISOString().slice(0, 10);

  beforeAll(async () => {
    database = await createTestDatabase('wp57_promotion');
    const [tenant] = await database.sql<{ seed_tenant_fixture: string }[]>`
      select app.seed_tenant_fixture('wp57-promotion', ${OWNER}, 'owner')
    `;
    orgId = tenant?.seed_tenant_fixture ?? '';
    const [profile] = await database.sql<{ id: string }[]>`
      select id from public.ad_profiles where org_id = ${orgId} limit 1
    `;
    profileId = profile?.id ?? '';
  }, 60_000);

  afterAll(async () => {
    await database?.drop();
  });

  it('replaces stale canonical rows, appends revisions, and rejects late older evidence', async () => {
    const first = promotion({
      orgId,
      profileId,
      reportDate,
      reportRequestId: FIRST_REQUEST,
      requestedAt: new Date(`${reportDate}T01:00:00Z`),
      observedAt: new Date(`${reportDate}T02:00:00Z`),
      sourceRows: 2,
      parsedRows: 2,
      refusedRows: 0,
      targetIds: ['target-old-1', 'target-old-2'],
    });
    const firstResult = await promoteReportDate(database, first);
    expect(firstResult).toMatchObject({
      status: 'promoted',
      deletedRows: 0,
      insertedRows: 2,
      observationRows: 1,
      watermark: { sourceRows: 2, parsedRows: 2, refusedRows: 0, promotedRows: 2, canonicalRows: 2 },
    });

    const second = promotion({
      orgId,
      profileId,
      reportDate,
      reportRequestId: SECOND_REQUEST,
      requestedAt: new Date(`${reportDate}T03:00:00Z`),
      observedAt: new Date(`${reportDate}T04:00:00Z`),
      sourceRows: 2,
      parsedRows: 1,
      refusedRows: 1,
      targetIds: ['target-current'],
    });
    const secondResult = await promoteReportDate(database, second);
    expect(secondResult).toMatchObject({
      status: 'promoted',
      deletedRows: 2,
      insertedRows: 1,
      observationRows: 1,
      watermark: { sourceRows: 2, parsedRows: 1, refusedRows: 1, promotedRows: 1, canonicalRows: 1 },
    });

    const facts = await database.sql<{ target_id: string; report_request_id: string }[]>`
      select target_id, report_request_id
        from public.fact_sp_target_daily
       where profile_id = ${profileId} and date = ${reportDate}
    `;
    expect(facts).toEqual([{ target_id: 'target-current', report_request_id: SECOND_REQUEST }]);

    const observations = await database.sql<{ source_observation_key: string; superseded_at: string | null }[]>`
      select source_observation_key, superseded_at::text
        from public.attribution_observations
       where profile_id = ${profileId} and event_date = ${reportDate}
       order by observed_at
    `;
    expect(observations).toHaveLength(2);
    expect(observations[0]?.superseded_at).not.toBeNull();
    expect(observations[1]?.superseded_at).toBeNull();

    const stale = promotion({
      orgId,
      profileId,
      reportDate,
      reportRequestId: STALE_REQUEST,
      requestedAt: new Date(`${reportDate}T02:30:00Z`),
      observedAt: new Date(`${reportDate}T05:00:00Z`),
      sourceRows: 1,
      parsedRows: 1,
      refusedRows: 0,
      targetIds: ['target-stale'],
    });
    await expect(promoteReportDate(database, stale)).rejects.toBeInstanceOf(StaleReportDatePromotion);

    expect(await promoteReportDate(database, second)).toMatchObject({
      status: 'already_promoted',
      deletedRows: 0,
      insertedRows: 0,
      observationRows: 0,
    });

    const [counts] = await database.sql<{ facts: string; observations: string }[]>`
      select
        (select count(*) from public.fact_sp_target_daily
          where profile_id = ${profileId} and date = ${reportDate}) as facts,
        (select count(*) from public.attribution_observations
          where profile_id = ${profileId} and event_date = ${reportDate}) as observations
    `;
    expect(Number(counts?.facts)).toBe(1);
    expect(Number(counts?.observations)).toBe(2);
  });
});

function targetFact(
  base: Pick<ReportDatePromotionInput, 'orgId' | 'profileId' | 'reportDate' | 'reportRequestId'>,
  targetId: string,
  purchases7d: number,
  sales7d: number,
) {
  return {
    orgId: base.orgId,
    profileId: base.profileId,
    date: base.reportDate,
    adProduct: 'SP' as const,
    campaignId: 'campaign-synthetic',
    adGroupId: 'ad-group-synthetic',
    targetId,
    targetKind: 'keyword' as const,
    matchType: 'exact' as const,
    impressions: 100,
    clicks: 10,
    cost: 12,
    purchases1d: 1,
    purchases7d,
    purchases14d: purchases7d,
    purchases30d: purchases7d,
    sales1d: 8,
    sales7d,
    sales14d: sales7d,
    sales30d: sales7d,
    unitsSold7d: purchases7d,
    topOfSearchImpressionShare: null,
    reportRequestId: base.reportRequestId,
  };
}

function promotion(input: {
  orgId: string;
  profileId: string;
  reportDate: string;
  reportRequestId: string;
  requestedAt: Date;
  observedAt: Date;
  sourceRows: number;
  parsedRows: number;
  refusedRows: number;
  targetIds: string[];
}): ReportDatePromotionInput {
  const base = {
    ...input,
    reportType: 'spTargeting' as const,
    source: 'amazon_reporting_v3' as const,
    attribution: { attributionWindowDays: 7, eventDateAgeDays: 1 },
  };
  return {
    ...base,
    batch: {
      kind: 'sp_target',
      rows: input.targetIds.map((targetId) => targetFact(base, targetId, 1, 8)),
    },
  };
}
