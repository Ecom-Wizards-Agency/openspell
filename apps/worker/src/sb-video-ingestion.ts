/**
 * Read-only Sponsored Brands Video observed-attribution runtime.
 *
 * Asset and ad pages are current observations. They may support a deliberately
 * gated single-day fact join, but they never claim to be time-valid historical
 * mappings and this module never calls an Amazon mutation endpoint.
 */
import {
  parseSbAdsReportProbe,
  type CreativeAssetProbePage,
  type SbAdProbePage,
  type SbAdProbeRow,
  type SbAdsReportProbeParseResult,
} from '@wizard-ads/ads-api';
import {
  persistCreativePerformanceBatch,
  readCreativeSyncSnapshotEvidence,
  type CreativePerformanceWriteBatch,
  type CreativePersistenceCounts,
  type CreativeSyncSnapshotEvidence,
  type DbHandle,
} from '@wizard-ads/db';
import {
  CreativeSyncSnapshot,
  type AdCreativeAssetMapping,
  type CreativeAsset,
  type CreativeAttributionState,
  type CreativeDailyFact,
  type CreativeSyncJob,
  type JobPayload,
  type WorkerReportLedger,
} from '@wizard-ads/shared';
import type {
  AdsProfileContext,
  SbVideoContractProbeClient,
} from './ads-api.js';
import {
  creativeMappingSourceKey,
  stageCreativePerformanceBatch,
} from './creative-performance.js';
import type { WorkerStore } from './store.js';

export interface SbVideoIngestionStore {
  persist(batch: CreativePerformanceWriteBatch): Promise<CreativePersistenceCounts>;
  evidence(scope: {
    orgId: string;
    profileId: string;
    snapshotId: string;
  }): Promise<CreativeSyncSnapshotEvidence>;
  enqueueReport(payload: Extract<JobPayload, { type: 'report.request' }>, dedupeKey: string): Promise<boolean>;
}

export class PostgresSbVideoIngestionStore implements SbVideoIngestionStore {
  constructor(
    private readonly handle: DbHandle,
    private readonly queue: Pick<WorkerStore, 'enqueue'>,
    private readonly now: () => Date = () => new Date(),
  ) {}

  persist(batch: CreativePerformanceWriteBatch): Promise<CreativePersistenceCounts> {
    return persistCreativePerformanceBatch(this.handle, batch);
  }

  evidence(scope: {
    orgId: string;
    profileId: string;
    snapshotId: string;
  }): Promise<CreativeSyncSnapshotEvidence> {
    return readCreativeSyncSnapshotEvidence(this.handle, scope);
  }

  enqueueReport(
    payload: Extract<JobPayload, { type: 'report.request' }>,
    dedupeKey: string,
  ): Promise<boolean> {
    return this.queue.enqueue(payload, this.now(), dedupeKey);
  }
}

export interface SbVideoSnapshotResult extends Record<string, unknown> {
  status: CreativeSyncSnapshot['status'];
  sourceAssets: number;
  parsedAssets: number;
  sourceAds: number;
  parsedAds: number;
  mapped: number;
  legacy: number;
  unsupported: number;
  ambiguous: number;
  unmapped: number;
  assetsUpserted: number;
  mappingsUpserted: number;
  snapshotsUpserted: number;
  assetsReadBack: number;
  mappingsReadBack: number;
  snapshotsReadBack: number;
  reportEnqueued: boolean;
  amazonWriteCalls: 0;
  reasons: string[];
}

export interface SbVideoReportResult extends Record<string, unknown> {
  blocked: boolean;
  idempotentReplay: boolean;
  reportSourceRows: number;
  reportParsedRows: number;
  reportRefusedRows: number;
  mappedFactRows: number;
  unpromotedReportRows: number;
  factsUpserted: number;
  factsReadBack: number;
  amazonWriteCalls: 0;
  reasons: string[];
}

type WorkerLedgerWithDate = Omit<WorkerReportLedger, 'requestedAt'> & { requestedAt: Date };

export interface SbVideoIngestionRuntime {
  syncSnapshot(input: {
    jobId: string;
    profile: AdsProfileContext;
    payload: CreativeSyncJob;
  }): Promise<SbVideoSnapshotResult>;
  ingestReport(input: {
    profile: AdsProfileContext;
    ledger: WorkerLedgerWithDate;
  } & (
    | { rawRows: readonly unknown[]; parsedReport?: never }
    | { parsedReport: SbAdsReportProbeParseResult; rawRows?: never }
  )): Promise<SbVideoReportResult>;
}

export class ObservedSbVideoIngestion implements SbVideoIngestionRuntime {
  constructor(
    private readonly client: SbVideoContractProbeClient,
    private readonly store: SbVideoIngestionStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async syncSnapshot(input: {
    jobId: string;
    profile: AdsProfileContext;
    payload: CreativeSyncJob;
  }): Promise<SbVideoSnapshotResult> {
    if (
      input.payload.allowObservedAttributionFacts &&
      input.payload.startDate !== input.payload.endDate
    ) {
      throw new Error('observed SB attribution facts are limited to one day; historical backfill is disabled');
    }
    const observationStartedAt = this.now();
    if (input.payload.allowObservedAttributionFacts) {
      const observedDate = profileLocalDate(observationStartedAt, input.profile.timezone);
      if (input.payload.startDate !== observedDate) {
        throw new Error(
          `observed SB attribution facts require the profile-local observation date ${observedDate}; historical or future dates are disabled`,
        );
      }
    }

    const adsPage = await this.client.probeSbAdsPage(input.profile);
    const assetsPage = await this.client.probeCreativeAssetsPage(input.profile);
    const observedAt = this.now();
    if (
      input.payload.allowObservedAttributionFacts &&
      profileLocalDate(observedAt, input.profile.timezone) !== input.payload.startDate
    ) {
      throw new Error(
        'profile-local date changed during the SB creative observation; fact attribution is disabled for this snapshot',
      );
    }
    const staged = stageCurrentSnapshot({
      snapshotId: input.jobId,
      orgId: input.payload.orgId,
      profileId: input.payload.profileId,
      startDate: input.payload.startDate,
      endDate: input.payload.endDate,
      observedAt: observedAt.toISOString(),
      allowFacts: input.payload.allowObservedAttributionFacts === true,
      adsPage,
      assetsPage,
    });
    const persistence = await this.store.persist(staged.batch);
    const expectedUpserts = staged.batch.assets.length + staged.batch.mappings.length + 1;
    if (persistence.totalUpserts !== expectedUpserts) {
      throw new Error(
        `creative snapshot expected ${expectedUpserts} upserts, received ${persistence.totalUpserts}`,
      );
    }
    if (
      persistence.assetsReadBack !== staged.batch.assets.length ||
      persistence.mappingsReadBack !== staged.batch.mappings.length ||
      persistence.snapshotsReadBack !== 1
    ) throw new Error('creative snapshot upserts/readback did not reconcile');

    let reportEnqueued = false;
    if (staged.snapshot.status === 'report_pending') {
      reportEnqueued = await this.store.enqueueReport({
        type: 'report.request',
        orgId: input.payload.orgId,
        profileId: input.payload.profileId,
        reportType: 'sbAds',
        startDate: input.payload.startDate,
        endDate: input.payload.endDate,
        creativeSyncSnapshotId: input.jobId,
      }, `sbAds:${input.jobId}`);
    }

    return {
      status: staged.snapshot.status,
      sourceAssets: staged.snapshot.sourceAssets,
      parsedAssets: staged.snapshot.parsedAssets,
      sourceAds: staged.snapshot.sourceAds,
      parsedAds: staged.snapshot.parsedAds,
      mapped: staged.snapshot.mapped,
      legacy: staged.snapshot.legacy,
      unsupported: staged.snapshot.unsupported,
      ambiguous: staged.snapshot.ambiguous,
      unmapped: staged.snapshot.unmapped,
      assetsUpserted: persistence.assetsUpserted,
      mappingsUpserted: persistence.mappingsUpserted,
      snapshotsUpserted: persistence.snapshotsUpserted,
      assetsReadBack: persistence.assetsReadBack,
      mappingsReadBack: persistence.mappingsReadBack,
      snapshotsReadBack: persistence.snapshotsReadBack,
      reportEnqueued,
      amazonWriteCalls: 0,
      reasons: staged.reasons,
    };
  }

  async ingestReport(input: {
    profile: AdsProfileContext;
    ledger: WorkerLedgerWithDate;
  } & (
    | { rawRows: readonly unknown[]; parsedReport?: never }
    | { parsedReport: SbAdsReportProbeParseResult; rawRows?: never }
  )): Promise<SbVideoReportResult> {
    if (input.ledger.reportType !== 'sbAds' || input.ledger.creativeSyncSnapshotId === null) {
      throw new Error('sbAds report is missing its creative snapshot provenance');
    }
    const evidence = await this.store.evidence({
      orgId: input.ledger.orgId,
      profileId: input.ledger.profileId,
      snapshotId: input.ledger.creativeSyncSnapshotId,
    });
    if (
      !evidence.snapshot.factPromotionAllowed ||
      evidence.snapshot.startDate !== evidence.snapshot.endDate ||
      evidence.snapshot.startDate !== input.ledger.startDate ||
      evidence.snapshot.endDate !== input.ledger.endDate ||
      !evidence.snapshot.paginationComplete
    ) {
      throw new Error('sbAds fact promotion is not explicitly allowed by this complete single-day snapshot');
    }

    if (evidence.snapshot.status === 'completed' || evidence.snapshot.status === 'blocked') {
      const reportSourceRows = evidence.snapshot.reportSourceRows;
      const reportParsedRows = evidence.snapshot.reportParsedRows;
      const reportRefusedRows = evidence.snapshot.reportRefusedRows;
      if (
        reportSourceRows === null ||
        reportParsedRows === null ||
        reportRefusedRows === null ||
        evidence.persistence.factsReadBack !== evidence.snapshot.mappedFactRows
      ) {
        throw new Error(`${evidence.snapshot.status} sbAds snapshot is missing its reconciled durable counts`);
      }
      const blocked = evidence.snapshot.status === 'blocked';
      return {
        blocked,
        idempotentReplay: true,
        reportSourceRows,
        reportParsedRows,
        reportRefusedRows,
        mappedFactRows: evidence.snapshot.mappedFactRows,
        unpromotedReportRows: evidence.snapshot.unpromotedReportRows,
        factsUpserted: 0,
        factsReadBack: evidence.persistence.factsReadBack,
        amazonWriteCalls: 0,
        reasons: blocked ? ['persisted_blocked_snapshot'] : [],
      };
    }
    if (evidence.snapshot.status !== 'report_pending') {
      throw new Error(`sbAds snapshot status ${evidence.snapshot.status} cannot promote facts`);
    }

    const report = input.parsedReport ?? parseSbAdsReportProbe(input.rawRows);
    const reasons: string[] = [];
    const duplicateGrains = duplicateReportGrains(report.rows);
    if (report.refusals.length > 0) reasons.push('report_rows_refused');
    if (duplicateGrains > 0) reasons.push('duplicate_ad_date_rows');
    if (report.rows.some((row) => row.date !== input.ledger.startDate)) {
      reasons.push('report_date_outside_snapshot');
    }
    if (reasons.length > 0) {
      const snapshot = reportSnapshot(evidence.snapshot, {
        status: 'blocked',
        sourceRows: report.sourceRows,
        parsedRows: report.parsedRows,
        refusedRows: report.refusals.length,
        mappedFactRows: 0,
        unpromotedReportRows: report.parsedRows,
      });
      const persistence = await this.store.persist(emptyBatch(input.ledger, snapshot));
      assertSnapshotOnly(persistence);
      return reportResult(true, report, 0, report.parsedRows, persistence, reasons);
    }

    const exactMappings = exactMappingIndex(evidence);
    const mappings = new Map<string, AdCreativeAssetMapping>();
    const facts: CreativeDailyFact[] = [];
    for (const row of report.rows) {
      if (row.adId === null || !completeMetrics(row)) continue;
      const candidates = exactMappings.get(reportMappingKey(row.campaignId, row.adGroupId, row.adId)) ?? [];
      if (candidates.length !== 1) continue;
      const mapping = candidates[0]!;
      if (
        mapping.attributionState !== 'mapped' ||
        mapping.assetId === null ||
        mapping.creativeVersion === null ||
        mapping.mappingProvenance !== 'current_sb_ad_snapshot' ||
        mapping.creativeSyncSnapshotId !== evidence.snapshot.id
      ) continue;
      mappings.set(creativeMappingSourceKey(mapping), mapping);
      facts.push({
        profileId: input.profile.id,
        date: row.date,
        adProduct: 'SB',
        campaignId: row.campaignId,
        adGroupId: row.adGroupId,
        adId: row.adId,
        creativeId: null,
        creativeVersion: mapping.creativeVersion,
        assetId: mapping.assetId,
        placement: null,
        attributionState: 'mapped',
        mappingProvenance: 'current_sb_ad_snapshot',
        creativeSyncSnapshotId: evidence.snapshot.id,
        impressions: row.impressions,
        clicks: row.clicks,
        cost: row.cost,
        purchases: row.purchases,
        sales: row.sales,
        videoFirstQuartileViews: row.videoFirstQuartileViews,
        videoMidpointViews: row.videoMidpointViews,
        videoThirdQuartileViews: row.videoThirdQuartileViews,
        videoCompleteViews: row.videoCompleteViews,
      });
    }
    const snapshot = reportSnapshot(evidence.snapshot, {
      status: 'completed',
      sourceRows: report.sourceRows,
      parsedRows: report.parsedRows,
      refusedRows: 0,
      mappedFactRows: facts.length,
      unpromotedReportRows: report.parsedRows - facts.length,
    });
    const staged = stageCreativePerformanceBatch({
      orgId: input.ledger.orgId,
      profileId: input.ledger.profileId,
      assets: [],
      mappings: [...mappings.values()],
      facts,
      snapshot,
    });
    if (staged.refusals.length > 0 || staged.writeBatch.facts.length !== facts.length) {
      throw new Error('normalized sbAds rows failed the creative ingestion contract');
    }
    const persistence = await this.store.persist(staged.writeBatch);
    if (
      persistence.factsUpserted !== facts.length ||
      persistence.factsReadBack !== facts.length ||
      persistence.snapshotsUpserted !== 1 ||
      persistence.snapshotsReadBack !== 1 ||
      persistence.mappingsReadBack !== mappings.size
    ) {
      throw new Error('sbAds fact upserts/readback did not reconcile');
    }
    return reportResult(
      false,
      report,
      facts.length,
      report.parsedRows - facts.length,
      persistence,
      [],
    );
  }
}

function stageCurrentSnapshot(input: {
  snapshotId: string;
  orgId: string;
  profileId: string;
  startDate: string;
  endDate: string;
  observedAt: string;
  allowFacts: boolean;
  adsPage: SbAdProbePage;
  assetsPage: CreativeAssetProbePage;
}): { batch: CreativePerformanceWriteBatch; snapshot: CreativeSyncSnapshot; reasons: string[] } {
  const reasons: string[] = [];
  const paginationComplete = input.adsPage.nextToken === null
    && input.assetsPage.nextToken === null
    && (input.adsPage.totalResults === null || input.adsPage.totalResults === input.adsPage.sourceRows)
    && (input.assetsPage.totalRecords === null || input.assetsPage.totalRecords === input.assetsPage.sourceRows);
  if (!paginationComplete) reasons.push('pagination_incomplete');
  const sourceCountsReconcile = input.adsPage.sourceRows === input.adsPage.items.length
    && input.assetsPage.sourceRows === input.assetsPage.items.length;
  if (!sourceCountsReconcile) reasons.push('source_parse_count_mismatch');

  const duplicateAssetIds = duplicates(input.assetsPage.items.map((asset) => asset.assetId));
  if (duplicateAssetIds.size > 0) reasons.push('duplicate_asset_ids');
  const assetById = new Map(input.assetsPage.items.map((asset) => [asset.assetId, asset]));
  const duplicateAdIds = duplicates(
    input.adsPage.items.flatMap((ad) => ad.adId === null ? [] : [ad.adId]),
  );
  const states = new Map<CreativeAttributionState, number>([
    ['mapped', 0],
    ['legacy', 0],
    ['unsupported', 0],
    ['ambiguous', 0],
    ['unmapped', 0],
  ]);
  const mappings = new Map<string, AdCreativeAssetMapping>();
  for (const ad of input.adsPage.items) {
    const classified = classifyAd(ad, assetById, duplicateAdIds);
    states.set(classified.state, (states.get(classified.state) ?? 0) + 1);
    if (ad.adId === null) continue;
    const mapping: AdCreativeAssetMapping = {
      profileId: input.profileId,
      adProduct: 'SB',
      campaignId: ad.campaignId,
      adGroupId: ad.adGroupId,
      adId: ad.adId,
      creativeId: null,
      creativeVersion: ad.creativeVersion,
      assetId: classified.state === 'mapped' ? classified.assetId : null,
      placement: null,
      attributionState: classified.state,
      mappingProvenance: 'current_sb_ad_snapshot',
      creativeSyncSnapshotId: input.snapshotId,
      observedAt: input.observedAt,
    };
    mappings.set(creativeMappingSourceKey(mapping), mapping);
  }
  const canPersistCanonical = paginationComplete
    && sourceCountsReconcile
    && duplicateAssetIds.size === 0;
  const status = !canPersistCanonical
    ? 'blocked'
    : input.allowFacts
      ? 'report_pending'
      : 'mapping_only';
  const snapshot = CreativeSyncSnapshot.parse({
    id: input.snapshotId,
    profileId: input.profileId,
    startDate: input.startDate,
    endDate: input.endDate,
    observedAt: input.observedAt,
    mappingProvenance: 'current_sb_ad_snapshot',
    historicalValidity: 'unproven_current_snapshot',
    status,
    paginationComplete,
    factPromotionAllowed: canPersistCanonical && input.allowFacts,
    sourceAssets: input.assetsPage.sourceRows,
    parsedAssets: input.assetsPage.items.length,
    sourceAds: input.adsPage.sourceRows,
    parsedAds: input.adsPage.items.length,
    mapped: states.get('mapped') ?? 0,
    legacy: states.get('legacy') ?? 0,
    unsupported: states.get('unsupported') ?? 0,
    ambiguous: states.get('ambiguous') ?? 0,
    unmapped: states.get('unmapped') ?? 0,
    mappedFactRows: 0,
    unpromotedReportRows: 0,
  });
  if (!canPersistCanonical) {
    return {
      snapshot,
      reasons,
      batch: {
        orgId: input.orgId,
        profileId: input.profileId,
        assets: [],
        mappings: [],
        facts: [],
        snapshot,
      },
    };
  }
  const assets: CreativeAsset[] = input.assetsPage.items.flatMap((asset) =>
    asset.assetType.toUpperCase().includes('VIDEO')
      ? [{
          profileId: input.profileId,
          assetId: asset.assetId,
          name: asset.name,
          assetType: asset.assetType,
          contentHash: asset.contentHash,
          thumbnailUrl: asset.thumbnailUrl ?? asset.defaultUrl,
        }]
      : []);
  const staged = stageCreativePerformanceBatch({
    orgId: input.orgId,
    profileId: input.profileId,
    assets,
    mappings: [...mappings.values()],
    facts: [],
    snapshot,
  });
  if (staged.refusals.length > 0) {
    throw new Error(`normalized creative snapshot produced ${staged.refusals.length} refusals`);
  }
  return { snapshot, reasons, batch: staged.writeBatch };
}

function classifyAd(
  ad: SbAdProbeRow,
  assetById: ReadonlyMap<string, CreativeAssetProbePage['items'][number]>,
  duplicateAdIds: ReadonlySet<string>,
): { state: CreativeAttributionState; assetId: string | null } {
  if (ad.adId === null) return { state: 'legacy', assetId: null };
  if (duplicateAdIds.has(ad.adId)) return { state: 'ambiguous', assetId: null };
  if (
    ad.videoAssets.some((reference) => reference.kind === 'legacy_media')
  ) return { state: 'legacy', assetId: null };
  if (
    !ad.creativePresent ||
    ad.videoAssets.length === 0 ||
    ad.creativeType?.toUpperCase().includes('VIDEO') === false
  ) return { state: 'unsupported', assetId: null };
  if (ad.videoAssets.length !== 1) return { state: 'ambiguous', assetId: null };
  const reference = ad.videoAssets[0]!;
  const asset = assetById.get(reference.assetId);
  if (asset === undefined) return { state: 'unmapped', assetId: null };
  if (!asset.assetType.toUpperCase().includes('VIDEO')) {
    return { state: 'unsupported', assetId: null };
  }
  if (ad.creativeVersion === null) return { state: 'unmapped', assetId: null };
  return { state: 'mapped', assetId: reference.assetId };
}

function exactMappingIndex(evidence: CreativeSyncSnapshotEvidence): Map<string, AdCreativeAssetMapping[]> {
  const result = new Map<string, AdCreativeAssetMapping[]>();
  for (const { mapping } of evidence.mappings) {
    const key = reportMappingKey(mapping.campaignId, mapping.adGroupId, mapping.adId);
    const current = result.get(key) ?? [];
    current.push(mapping);
    result.set(key, current);
  }
  return result;
}

function reportMappingKey(campaignId: string, adGroupId: string, adId: string): string {
  return JSON.stringify([campaignId, adGroupId, adId]);
}

function duplicateReportGrains(rows: readonly { date: string; adId: string | null }[]): number {
  const seen = new Set<string>();
  let duplicates = 0;
  for (const row of rows) {
    if (row.adId === null) continue;
    const key = JSON.stringify([row.date, row.adId]);
    if (seen.has(key)) duplicates += 1;
    else seen.add(key);
  }
  return duplicates;
}

function completeMetrics(row: ReturnType<typeof parseSbAdsReportProbe>['rows'][number]): row is
  typeof row & {
    impressions: number;
    clicks: number;
    cost: number;
    purchases: number;
    sales: number;
    videoFirstQuartileViews: number;
    videoMidpointViews: number;
    videoThirdQuartileViews: number;
    videoCompleteViews: number;
  } {
  return row.impressions !== null
    && row.clicks !== null
    && row.cost !== null
    && row.purchases !== null
    && row.sales !== null
    && row.videoFirstQuartileViews !== null
    && row.videoMidpointViews !== null
    && row.videoThirdQuartileViews !== null
    && row.videoCompleteViews !== null;
}

function reportSnapshot(
  snapshot: CreativeSyncSnapshot,
  report: {
    status: 'completed' | 'blocked';
    sourceRows: number;
    parsedRows: number;
    refusedRows: number;
    mappedFactRows: number;
    unpromotedReportRows: number;
  },
): CreativeSyncSnapshot {
  return CreativeSyncSnapshot.parse({
    ...snapshot,
    status: report.status,
    reportSourceRows: report.sourceRows,
    reportParsedRows: report.parsedRows,
    reportRefusedRows: report.refusedRows,
    mappedFactRows: report.mappedFactRows,
    unpromotedReportRows: report.unpromotedReportRows,
  });
}

function emptyBatch(
  ledger: WorkerLedgerWithDate,
  snapshot: CreativeSyncSnapshot,
): CreativePerformanceWriteBatch {
  return {
    orgId: ledger.orgId,
    profileId: ledger.profileId,
    assets: [],
    mappings: [],
    facts: [],
    snapshot,
  };
}

function assertSnapshotOnly(persistence: CreativePersistenceCounts): void {
  if (
    persistence.totalUpserts !== 1 ||
    persistence.assetsUpserted !== 0 ||
    persistence.mappingsUpserted !== 0 ||
    persistence.factsUpserted !== 0 ||
    persistence.snapshotsUpserted !== 1 ||
    persistence.snapshotsReadBack !== 1
  ) throw new Error('blocked sbAds report wrote outside its count-only snapshot');
}

function reportResult(
  blocked: boolean,
  report: ReturnType<typeof parseSbAdsReportProbe>,
  mappedFactRows: number,
  unpromotedReportRows: number,
  persistence: CreativePersistenceCounts,
  reasons: string[],
): SbVideoReportResult {
  return {
    blocked,
    idempotentReplay: false,
    reportSourceRows: report.sourceRows,
    reportParsedRows: report.parsedRows,
    reportRefusedRows: report.refusals.length,
    mappedFactRows,
    unpromotedReportRows,
    factsUpserted: persistence.factsUpserted,
    factsReadBack: persistence.factsReadBack,
    amazonWriteCalls: 0,
    reasons,
  };
}

function duplicates(values: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const result = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) result.add(value);
    else seen.add(value);
  }
  return result;
}

function profileLocalDate(observedAt: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(observedAt);
  const byType = new Map(parts.map((part) => [part.type, part.value]));
  const year = byType.get('year');
  const month = byType.get('month');
  const day = byType.get('day');
  if (year === undefined || month === undefined || day === undefined) {
    throw new Error(`could not resolve observation date for profile timezone ${timezone}`);
  }
  return `${year}-${month}-${day}`;
}
