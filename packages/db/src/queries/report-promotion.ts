/**
 * Transactional promotion of one complete report date.
 *
 * The current Reporting v3 loader upserts a whole downloaded range directly.
 * This module is the stricter seam for the replacement loader: it validates a
 * fully-accounted date before opening a transaction, serializes concurrent
 * attempts for the same scope, appends attribution evidence, replaces the
 * canonical day, and records counts only after reading them back.
 *
 * Nothing here schedules or calls Amazon. The worker proves source accounting
 * first; Sponsored Products Reporting v3 now uses this path, while SB and SD
 * retain their prior loader.
 */
import {
  and,
  count as countRows,
  desc,
  eq,
  getTableColumns,
  isNull,
  sql,
} from 'drizzle-orm';
import type {
  AdProduct,
  ReportDataSource,
  ReportPromotionWatermark,
  ReportType,
} from '@wizard-ads/shared';
import type { DbHandle } from '../client.js';
import {
  attributionObservations,
  factPlacementDaily,
  factProfileDaily,
  factSbDaily,
  factSdDaily,
  factSearchTermDaily,
  factSpTargetDaily,
  reportRequests,
  reportPromotionWatermarks,
  type NewPlacementFact,
  type NewProfileFact,
  type NewSbFact,
  type NewSdFact,
  type NewSearchTermFact,
  type NewSpTargetFact,
} from '../schema/index.js';
import { chunkForInsert } from './chunk.js';
import { assertUniqueFactGrain } from './facts.js';

export type PromotableReportFactBatch =
  | { kind: 'sp_target'; rows: readonly NewSpTargetFact[] }
  | { kind: 'search_term'; rows: readonly NewSearchTermFact[] }
  | { kind: 'placement'; rows: readonly NewPlacementFact[] }
  | { kind: 'profile'; rows: readonly NewProfileFact[] }
  | { kind: 'sb'; rows: readonly NewSbFact[] }
  | { kind: 'sd'; rows: readonly NewSdFact[] };

export interface AttributionRevisionInput {
  /** Attribution window represented by purchases/sales in this report. */
  attributionWindowDays: number;
  /** Profile-local age of reportDate when the evidence was observed. */
  eventDateAgeDays: number;
}

export interface ReportDatePromotionInput {
  orgId: string;
  profileId: string;
  reportType: ReportType;
  reportDate: string;
  source: ReportDataSource;
  reportRequestId: string;
  requestedAt: Date;
  observedAt: Date;
  sourceRows: number;
  parsedRows: number;
  refusedRows: number;
  attribution: AttributionRevisionInput;
  batch: PromotableReportFactBatch;
}

export interface StagedReportDate extends ReportDatePromotionInput {
  promotedRows: number;
  observation: {
    adProduct: AdProduct;
    impressions: number;
    clicks: number;
    cost: number;
    purchases: number;
    sales: number;
  };
}

export interface ReportDatePromotionResult {
  status: 'promoted' | 'already_promoted' | 'superseded';
  deletedRows: number;
  insertedRows: number;
  observationRows: number;
  watermark: ReportPromotionWatermark;
}

export class InvalidReportDatePromotion extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidReportDatePromotion';
  }
}

export class StaleReportDatePromotion extends Error {
  constructor(
    readonly reportDate: string,
    readonly requestedAt: Date,
    readonly currentRequestedAt: Date,
  ) {
    super(
      `report date ${reportDate} was requested at ${requestedAt.toISOString()}, ` +
        `older than current promotion ${currentRequestedAt.toISOString()}`,
    );
    this.name = 'StaleReportDatePromotion';
  }
}

const REPORT_KIND: Readonly<Record<ReportType, PromotableReportFactBatch['kind']>> = {
  spTargeting: 'sp_target',
  spSearchTerm: 'search_term',
  spPlacement: 'placement',
  spCampaigns: 'profile',
  sbCampaigns: 'sb',
  sdCampaigns: 'sd',
};
const SP_REPORT_TYPES = new Set<ReportType>([
  'spCampaigns',
  'spTargeting',
  'spSearchTerm',
  'spPlacement',
]);

/** Validate and aggregate a complete date without touching the database. */
export function stageReportDate(input: ReportDatePromotionInput): StagedReportDate {
  assertUuid('orgId', input.orgId);
  assertUuid('profileId', input.profileId);
  assertUuid('reportRequestId', input.reportRequestId);
  assertIsoDate(input.reportDate);
  assertValidDate('requestedAt', input.requestedAt);
  assertValidDate('observedAt', input.observedAt);
  if (input.source !== 'amazon_reporting_v3' && input.source !== 'amazon_unified_reporting') {
    throw new InvalidReportDatePromotion(
      `${input.source} cannot replace canonical daily reporting facts`,
    );
  }
  if (input.observedAt < input.requestedAt) {
    throw new InvalidReportDatePromotion('observedAt must not precede requestedAt');
  }
  assertCount('sourceRows', input.sourceRows);
  assertCount('parsedRows', input.parsedRows);
  assertCount('refusedRows', input.refusedRows);
  assertCount('attributionWindowDays', input.attribution.attributionWindowDays, true);
  assertCount('eventDateAgeDays', input.attribution.eventDateAgeDays);

  if (input.sourceRows !== input.parsedRows + input.refusedRows) {
    throw new InvalidReportDatePromotion(
      `source rows do not reconcile: ${input.sourceRows} != ` +
        `${input.parsedRows} parsed + ${input.refusedRows} refused`,
    );
  }
  if (SP_REPORT_TYPES.has(input.reportType) && input.refusedRows !== 0) {
    throw new InvalidReportDatePromotion(
      `canonical replacement requires zero refused rows, received ${input.refusedRows}`,
    );
  }
  if (REPORT_KIND[input.reportType] !== input.batch.kind) {
    throw new InvalidReportDatePromotion(
      `${input.reportType} cannot promote a ${input.batch.kind} fact batch`,
    );
  }
  if (input.batch.rows.length > input.parsedRows) {
    throw new InvalidReportDatePromotion(
      `${input.batch.rows.length} promoted rows exceed ${input.parsedRows} parsed rows`,
    );
  }
  if (input.batch.kind !== 'profile' && input.batch.rows.length !== input.parsedRows) {
    throw new InvalidReportDatePromotion(
      `${input.batch.kind} is a one-to-one grain: ${input.parsedRows} parsed rows must produce ` +
        `${input.batch.rows.length} promoted rows`,
    );
  }

  for (const [index, row] of input.batch.rows.entries()) {
    if (row.orgId !== input.orgId || row.profileId !== input.profileId) {
      throw new InvalidReportDatePromotion(`row ${index} is outside the promotion tenant/profile`);
    }
    if (row.date !== input.reportDate) {
      throw new InvalidReportDatePromotion(`row ${index} belongs to ${row.date}, not ${input.reportDate}`);
    }
    if (row.reportRequestId !== input.reportRequestId) {
      throw new InvalidReportDatePromotion(`row ${index} has the wrong report request provenance`);
    }
  }
  if (SP_REPORT_TYPES.has(input.reportType)) assertUniquePromotionGrain(input.batch);

  const observation = aggregateObservation(input.batch, input.attribution.attributionWindowDays);
  assertCount('impressions', observation.impressions);
  assertCount('clicks', observation.clicks);
  assertMetric('cost', observation.cost);
  assertCount('purchases', observation.purchases);
  assertMetric('sales', observation.sales);
  if (observation.clicks > observation.impressions) {
    throw new InvalidReportDatePromotion('aggregate clicks must not exceed impressions');
  }

  return { ...input, promotedRows: input.batch.rows.length, observation };
}

/**
 * Atomically append attribution evidence and replace one canonical report day.
 * A scoped transaction advisory lock also closes the absent-watermark race.
 */
export async function promoteReportDate(
  handle: DbHandle,
  input: ReportDatePromotionInput | StagedReportDate,
): Promise<ReportDatePromotionResult> {
  const staged = stageReportDate(input);
  // Canonical fact tables do not carry a source column. All reporting sources
  // for a profile/report/date therefore share one lock and one freshness guard.
  const lockKey = [staged.profileId, staged.reportType, staged.reportDate].join(':');

  return handle.db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);

    if (SP_REPORT_TYPES.has(staged.reportType) && staged.source === 'amazon_reporting_v3') {
      const [request] = await tx
        .select({
          orgId: reportRequests.orgId,
          profileId: reportRequests.profileId,
          reportType: reportRequests.reportType,
          startDate: reportRequests.startDate,
          endDate: reportRequests.endDate,
          source: reportRequests.source,
          requestedAt: reportRequests.requestedAt,
        })
        .from(reportRequests)
        .where(eq(reportRequests.id, staged.reportRequestId))
        .limit(1);
      if (!request) {
        throw new InvalidReportDatePromotion('Reporting v3 promotion has no report request ledger');
      }
      if (request.orgId !== staged.orgId || request.profileId !== staged.profileId) {
        throw new InvalidReportDatePromotion('report request belongs to another tenant/profile');
      }
      if (request.reportType !== staged.reportType) {
        throw new InvalidReportDatePromotion('report request type does not match the promotion');
      }
      if (request.source !== 'amazon_api') {
        throw new InvalidReportDatePromotion('only an Amazon API report request may promote Reporting v3 facts');
      }
      if (staged.reportDate < request.startDate || staged.reportDate > request.endDate) {
        throw new InvalidReportDatePromotion('promoted date is outside the report request window');
      }
      if (request.requestedAt.getTime() !== staged.requestedAt.getTime()) {
        throw new InvalidReportDatePromotion('report request timestamp does not match the promotion');
      }
    }

    const currentRows = await tx
      .select()
      .from(reportPromotionWatermarks)
      .where(and(
        eq(reportPromotionWatermarks.profileId, staged.profileId),
        eq(reportPromotionWatermarks.reportType, staged.reportType),
        eq(reportPromotionWatermarks.reportDate, staged.reportDate),
      ))
      .orderBy(desc(reportPromotionWatermarks.requestedAt));
    const current = currentRows[0];
    const currentForSource = currentRows.find((row) => row.source === staged.source);

    if (
      currentForSource?.reportRequestId === staged.reportRequestId &&
      currentForSource.requestedAt.getTime() !== staged.requestedAt.getTime()
    ) {
      throw new InvalidReportDatePromotion('one report request cannot have two requestedAt timestamps');
    }
    if (current) {
      if (staged.requestedAt < current.requestedAt) {
        if (!SP_REPORT_TYPES.has(staged.reportType)) {
          throw new StaleReportDatePromotion(staged.reportDate, staged.requestedAt, current.requestedAt);
        }
        const canonicalRows = await countBatchCanonical(tx, staged);
        if (canonicalRows !== current.canonicalRows) {
          throw new InvalidReportDatePromotion(
            `newer canonical count drifted from ${current.canonicalRows} to ${canonicalRows}`,
          );
        }
        return {
          status: 'superseded',
          deletedRows: 0,
          insertedRows: 0,
          observationRows: 0,
          watermark: toWatermark(current),
        };
      }
      if (staged.requestedAt.getTime() === current.requestedAt.getTime()) {
        if (staged.reportRequestId !== current.reportRequestId) {
          throw new InvalidReportDatePromotion(
            'two different report requests cannot share one promotion timestamp',
          );
        }
        if (!currentForSource || currentForSource.reportRequestId !== staged.reportRequestId) {
          throw new InvalidReportDatePromotion('an idempotent retry changed its reporting source');
        }
        assertSameCounts(staged, currentForSource);
        const canonicalRows = await countBatchCanonical(tx, staged);
        if (canonicalRows !== currentForSource.canonicalRows) {
          throw new InvalidReportDatePromotion(
            `canonical count drifted from ${currentForSource.canonicalRows} to ${canonicalRows}`,
          );
        }
        return {
          status: 'already_promoted',
          deletedRows: 0,
          insertedRows: 0,
          observationRows: 0,
          watermark: toWatermark(currentForSource),
        };
      }
    }

    const [latestObservation] = await tx
      .select({ observedAt: attributionObservations.observedAt })
      .from(attributionObservations)
      .where(and(
        eq(attributionObservations.profileId, staged.profileId),
        eq(attributionObservations.eventDate, staged.reportDate),
        eq(attributionObservations.reportType, staged.reportType),
        eq(attributionObservations.source, staged.source),
      ))
      .orderBy(desc(attributionObservations.observedAt))
      .limit(1);
    if (latestObservation && latestObservation.observedAt > staged.observedAt) {
      throw new InvalidReportDatePromotion('a promotion cannot supersede a later attribution observation');
    }

    await tx
      .update(attributionObservations)
      .set({ supersededAt: staged.observedAt })
      .where(and(
        eq(attributionObservations.profileId, staged.profileId),
        eq(attributionObservations.eventDate, staged.reportDate),
        eq(attributionObservations.reportType, staged.reportType),
        eq(attributionObservations.source, staged.source),
        isNull(attributionObservations.supersededAt),
      ));

    const observation = await tx
      .insert(attributionObservations)
      .values({
        orgId: staged.orgId,
        profileId: staged.profileId,
        sourceObservationKey: `${staged.reportRequestId}:${staged.reportType}:${staged.reportDate}`,
        eventDate: staged.reportDate,
        adProduct: staged.observation.adProduct,
        reportType: staged.reportType,
        source: staged.source,
        observedAt: staged.observedAt,
        attributionWindowDays: staged.attribution.attributionWindowDays,
        eventDateAgeDays: staged.attribution.eventDateAgeDays,
        impressions: staged.observation.impressions,
        clicks: staged.observation.clicks,
        cost: staged.observation.cost,
        purchases: staged.observation.purchases,
        sales: staged.observation.sales,
        supersededAt: null,
      })
      .returning({ id: attributionObservations.id });
    if (observation.length !== 1) {
      throw new InvalidReportDatePromotion(`expected one attribution observation, wrote ${observation.length}`);
    }

    const replacement = await replaceCanonicalDate(tx, staged);
    if (replacement.insertedRows !== staged.promotedRows) {
      throw new InvalidReportDatePromotion(
        `promoted ${replacement.insertedRows} rows after staging ${staged.promotedRows}`,
      );
    }
    if (replacement.canonicalRows !== staged.promotedRows) {
      throw new InvalidReportDatePromotion(
        `canonical count ${replacement.canonicalRows} does not match ${staged.promotedRows} promoted rows`,
      );
    }

    const promotedAt = new Date();
    const [watermark] = await tx
      .insert(reportPromotionWatermarks)
      .values({
        orgId: staged.orgId,
        profileId: staged.profileId,
        reportType: staged.reportType,
        reportDate: staged.reportDate,
        source: staged.source,
        reportRequestId: staged.reportRequestId,
        requestedAt: staged.requestedAt,
        promotedAt,
        sourceRows: staged.sourceRows,
        parsedRows: staged.parsedRows,
        refusedRows: staged.refusedRows,
        promotedRows: staged.promotedRows,
        canonicalRows: replacement.canonicalRows,
      })
      .onConflictDoUpdate({
        target: [
          reportPromotionWatermarks.profileId,
          reportPromotionWatermarks.reportType,
          reportPromotionWatermarks.reportDate,
          reportPromotionWatermarks.source,
        ],
        set: {
          orgId: staged.orgId,
          reportRequestId: staged.reportRequestId,
          requestedAt: staged.requestedAt,
          promotedAt,
          sourceRows: staged.sourceRows,
          parsedRows: staged.parsedRows,
          refusedRows: staged.refusedRows,
          promotedRows: staged.promotedRows,
          canonicalRows: replacement.canonicalRows,
        },
      })
      .returning();
    if (!watermark) throw new InvalidReportDatePromotion('promotion watermark was not written');

    return {
      status: 'promoted',
      deletedRows: replacement.deletedRows,
      insertedRows: replacement.insertedRows,
      observationRows: observation.length,
      watermark: toWatermark(watermark),
    };
  });
}

type PromotionTransaction = Parameters<Parameters<DbHandle['db']['transaction']>[0]>[0];

async function replaceCanonicalDate(
  tx: PromotionTransaction,
  staged: StagedReportDate,
): Promise<{ deletedRows: number; insertedRows: number; canonicalRows: number }> {
  switch (staged.batch.kind) {
    case 'sp_target': {
      const deleted = await tx.delete(factSpTargetDaily)
        .where(and(
          eq(factSpTargetDaily.profileId, staged.profileId),
          eq(factSpTargetDaily.date, staged.reportDate),
        ))
        .returning({ profileId: factSpTargetDaily.profileId });
      let insertedRows = 0;
      for (const rows of chunkForInsert(staged.batch.rows, columnCount(factSpTargetDaily))) {
        const inserted = await tx.insert(factSpTargetDaily)
          .values(rows.map((row) => ({ ...row, loadedAt: staged.observedAt })))
          .returning({ profileId: factSpTargetDaily.profileId });
        insertedRows += inserted.length;
      }
      const canonicalRows = await countCanonical(tx, factSpTargetDaily, staged.profileId, staged.reportDate);
      return { deletedRows: deleted.length, insertedRows, canonicalRows };
    }
    case 'search_term': {
      const deleted = await tx.delete(factSearchTermDaily)
        .where(and(
          eq(factSearchTermDaily.profileId, staged.profileId),
          eq(factSearchTermDaily.date, staged.reportDate),
        ))
        .returning({ profileId: factSearchTermDaily.profileId });
      let insertedRows = 0;
      for (const rows of chunkForInsert(staged.batch.rows, columnCount(factSearchTermDaily))) {
        const inserted = await tx.insert(factSearchTermDaily)
          .values(rows.map((row) => ({ ...row, loadedAt: staged.observedAt })))
          .returning({ profileId: factSearchTermDaily.profileId });
        insertedRows += inserted.length;
      }
      const canonicalRows = await countCanonical(tx, factSearchTermDaily, staged.profileId, staged.reportDate);
      return { deletedRows: deleted.length, insertedRows, canonicalRows };
    }
    case 'placement': {
      const deleted = await tx.delete(factPlacementDaily)
        .where(and(
          eq(factPlacementDaily.profileId, staged.profileId),
          eq(factPlacementDaily.date, staged.reportDate),
        ))
        .returning({ profileId: factPlacementDaily.profileId });
      let insertedRows = 0;
      for (const rows of chunkForInsert(staged.batch.rows, columnCount(factPlacementDaily))) {
        const inserted = await tx.insert(factPlacementDaily)
          .values(rows.map((row) => ({ ...row, loadedAt: staged.observedAt })))
          .returning({ profileId: factPlacementDaily.profileId });
        insertedRows += inserted.length;
      }
      const canonicalRows = await countCanonical(tx, factPlacementDaily, staged.profileId, staged.reportDate);
      return { deletedRows: deleted.length, insertedRows, canonicalRows };
    }
    case 'profile': {
      const deleted = await tx.delete(factProfileDaily)
        .where(and(
          eq(factProfileDaily.profileId, staged.profileId),
          eq(factProfileDaily.date, staged.reportDate),
        ))
        .returning({ profileId: factProfileDaily.profileId });
      let insertedRows = 0;
      for (const rows of chunkForInsert(staged.batch.rows, columnCount(factProfileDaily))) {
        const inserted = await tx.insert(factProfileDaily)
          .values(rows.map((row) => ({ ...row, loadedAt: staged.observedAt })))
          .returning({ profileId: factProfileDaily.profileId });
        insertedRows += inserted.length;
      }
      const canonicalRows = await countCanonical(tx, factProfileDaily, staged.profileId, staged.reportDate);
      return { deletedRows: deleted.length, insertedRows, canonicalRows };
    }
    case 'sb': {
      const deleted = await tx.delete(factSbDaily)
        .where(and(
          eq(factSbDaily.profileId, staged.profileId),
          eq(factSbDaily.date, staged.reportDate),
        ))
        .returning({ profileId: factSbDaily.profileId });
      const inserted = staged.batch.rows.length === 0 ? [] : await tx.insert(factSbDaily)
        .values(staged.batch.rows.map((row) => ({ ...row, loadedAt: staged.observedAt })))
        .returning({ profileId: factSbDaily.profileId });
      const canonicalRows = await countCanonical(tx, factSbDaily, staged.profileId, staged.reportDate);
      return { deletedRows: deleted.length, insertedRows: inserted.length, canonicalRows };
    }
    case 'sd': {
      const deleted = await tx.delete(factSdDaily)
        .where(and(
          eq(factSdDaily.profileId, staged.profileId),
          eq(factSdDaily.date, staged.reportDate),
        ))
        .returning({ profileId: factSdDaily.profileId });
      const inserted = staged.batch.rows.length === 0 ? [] : await tx.insert(factSdDaily)
        .values(staged.batch.rows.map((row) => ({ ...row, loadedAt: staged.observedAt })))
        .returning({ profileId: factSdDaily.profileId });
      const canonicalRows = await countCanonical(tx, factSdDaily, staged.profileId, staged.reportDate);
      return { deletedRows: deleted.length, insertedRows: inserted.length, canonicalRows };
    }
  }
}

function countBatchCanonical(
  tx: PromotionTransaction,
  staged: StagedReportDate,
): Promise<number> {
  switch (staged.batch.kind) {
    case 'sp_target': return countCanonical(tx, factSpTargetDaily, staged.profileId, staged.reportDate);
    case 'search_term': return countCanonical(tx, factSearchTermDaily, staged.profileId, staged.reportDate);
    case 'placement': return countCanonical(tx, factPlacementDaily, staged.profileId, staged.reportDate);
    case 'profile': return countCanonical(tx, factProfileDaily, staged.profileId, staged.reportDate);
    case 'sb': return countCanonical(tx, factSbDaily, staged.profileId, staged.reportDate);
    case 'sd': return countCanonical(tx, factSdDaily, staged.profileId, staged.reportDate);
  }
}

type FactTable =
  | typeof factSpTargetDaily
  | typeof factSearchTermDaily
  | typeof factPlacementDaily
  | typeof factProfileDaily
  | typeof factSbDaily
  | typeof factSdDaily;

function columnCount(table: FactTable): number {
  return Object.keys(getTableColumns(table)).length;
}

async function countCanonical(
  tx: PromotionTransaction,
  table: FactTable,
  profileId: string,
  reportDate: string,
): Promise<number> {
  const [row] = await tx
    .select({ value: countRows() })
    .from(table)
    .where(and(eq(table.profileId, profileId), eq(table.date, reportDate)));
  return row?.value ?? 0;
}

function aggregateObservation(
  batch: PromotableReportFactBatch,
  attributionWindowDays: number,
): StagedReportDate['observation'] {
  let adProduct: AdProduct;
  let purchases = 0;
  let sales = 0;
  let impressions = 0;
  let clicks = 0;
  let cost = 0;

  switch (batch.kind) {
    case 'sp_target':
      adProduct = 'SP';
      if (![1, 7, 14, 30].includes(attributionWindowDays)) {
        throw new InvalidReportDatePromotion(
          `spTargeting does not expose a ${attributionWindowDays}-day attribution column`,
        );
      }
      for (const row of batch.rows) {
        if (row.adProduct !== 'SP') throw new InvalidReportDatePromotion('spTargeting rows must be SP');
        impressions += row.impressions ?? 0;
        clicks += row.clicks ?? 0;
        cost += row.cost ?? 0;
        switch (attributionWindowDays) {
          case 1: purchases += row.purchases1d ?? 0; sales += row.sales1d ?? 0; break;
          case 7: purchases += row.purchases7d ?? 0; sales += row.sales7d ?? 0; break;
          case 14: purchases += row.purchases14d ?? 0; sales += row.sales14d ?? 0; break;
          case 30: purchases += row.purchases30d ?? 0; sales += row.sales30d ?? 0; break;
        }
      }
      break;
    case 'search_term':
    case 'placement':
      adProduct = 'SP';
      requireSevenDayWindow(batch.kind, attributionWindowDays);
      for (const row of batch.rows) {
        if (row.adProduct !== 'SP') throw new InvalidReportDatePromotion(`${batch.kind} rows must be SP`);
        impressions += row.impressions ?? 0;
        clicks += row.clicks ?? 0;
        cost += row.cost ?? 0;
        purchases += row.purchases7d ?? 0;
        sales += row.sales7d ?? 0;
      }
      break;
    case 'profile':
      adProduct = 'SP';
      requireSevenDayWindow(batch.kind, attributionWindowDays);
      for (const row of batch.rows) {
        impressions += row.impressions ?? 0;
        clicks += row.clicks ?? 0;
        cost += row.cost ?? 0;
        purchases += row.purchases7d ?? 0;
        sales += row.sales7d ?? 0;
      }
      break;
    case 'sb':
    case 'sd':
      adProduct = batch.kind === 'sb' ? 'SB' : 'SD';
      requireSevenDayWindow(batch.kind, attributionWindowDays);
      for (const row of batch.rows) {
        impressions += row.impressions ?? 0;
        clicks += row.clicks ?? 0;
        cost += row.cost ?? 0;
        purchases += row.purchases7d ?? 0;
        sales += row.sales7d ?? 0;
      }
      break;
  }
  return { adProduct, impressions, clicks, cost, purchases, sales };
}

function assertUniquePromotionGrain(batch: PromotableReportFactBatch): void {
  switch (batch.kind) {
    case 'sp_target':
      assertUniqueFactGrain('fact_sp_target_daily', batch.rows, (row) => [
        row.profileId,
        row.date,
        row.adProduct,
        row.campaignId,
        row.adGroupId,
        row.targetId,
      ]);
      return;
    case 'search_term':
      assertUniqueFactGrain('fact_search_term_daily', batch.rows, (row) => [
        row.profileId,
        row.date,
        row.campaignId,
        row.adGroupId,
        row.targetId,
        row.searchTerm,
      ]);
      return;
    case 'placement':
      assertUniqueFactGrain('fact_placement_daily', batch.rows, (row) => [
        row.profileId,
        row.date,
        row.adProduct,
        row.campaignId,
        row.placement,
      ]);
      return;
    case 'profile':
      assertUniqueFactGrain('fact_profile_daily', batch.rows, (row) => [row.profileId, row.date]);
      return;
    case 'sb':
      assertUniqueFactGrain('fact_sb_daily', batch.rows, (row) => [
        row.profileId,
        row.date,
        row.campaignId,
        row.adGroupId,
      ]);
      return;
    case 'sd':
      assertUniqueFactGrain('fact_sd_daily', batch.rows, (row) => [
        row.profileId,
        row.date,
        row.campaignId,
        row.adGroupId,
      ]);
  }
}

function requireSevenDayWindow(kind: PromotableReportFactBatch['kind'], days: number): void {
  if (days !== 7) {
    throw new InvalidReportDatePromotion(`${kind} exposes only 7-day purchases and sales`);
  }
}

function assertSameCounts(
  staged: StagedReportDate,
  current: typeof reportPromotionWatermarks.$inferSelect,
): void {
  const expected = [
    staged.sourceRows,
    staged.parsedRows,
    staged.refusedRows,
    staged.promotedRows,
    staged.promotedRows,
  ];
  const actual = [
    current.sourceRows,
    current.parsedRows,
    current.refusedRows,
    current.promotedRows,
    current.canonicalRows,
  ];
  if (expected.some((value, index) => value !== actual[index])) {
    throw new InvalidReportDatePromotion('an idempotent promotion retry changed its reconciled counts');
  }
}

function toWatermark(row: typeof reportPromotionWatermarks.$inferSelect): ReportPromotionWatermark {
  return {
    profileId: row.profileId,
    reportType: row.reportType,
    date: row.reportDate,
    source: row.source,
    reportRequestId: row.reportRequestId,
    requestedAt: row.requestedAt.toISOString(),
    promotedAt: row.promotedAt.toISOString(),
    sourceRows: row.sourceRows,
    parsedRows: row.parsedRows,
    refusedRows: row.refusedRows,
    promotedRows: row.promotedRows,
    canonicalRows: row.canonicalRows,
  };
}

function assertCount(name: string, value: number, positive = false): void {
  if (!Number.isSafeInteger(value) || value < (positive ? 1 : 0)) {
    throw new InvalidReportDatePromotion(`${name} must be a ${positive ? 'positive' : 'non-negative'} safe integer`);
  }
}

function assertMetric(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new InvalidReportDatePromotion(`${name} must be a non-negative finite number`);
  }
}

function assertUuid(name: string, value: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new InvalidReportDatePromotion(`${name} must be a UUID`);
  }
}

function assertIsoDate(value: string): void {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value
  ) {
    throw new InvalidReportDatePromotion('reportDate must be YYYY-MM-DD');
  }
}

function assertValidDate(name: string, value: Date): void {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new InvalidReportDatePromotion(`${name} must be a valid Date`);
  }
}
