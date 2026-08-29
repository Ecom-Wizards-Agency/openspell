import type {
  CreativeAssetProbePage,
  SbAdProbePage,
  SbAdProbeRow,
} from '@wizard-ads/ads-api';
import type {
  CreativeMappingWrite,
  CreativePerformanceWriteBatch,
  CreativePersistenceCounts,
  CreativeSyncSnapshotEvidence,
} from '@wizard-ads/db';
import { describe, expect, it } from 'vitest';
import type { AdsProfileContext, SbVideoContractProbeClient } from './ads-api.js';
import {
  ObservedSbVideoIngestion,
  type SbVideoIngestionStore,
} from './sb-video-ingestion.js';

const ORG_ID = '85858585-8585-4585-8585-858585858585';
const PROFILE_ID = '86868686-8686-4686-8686-868686868686';
const SNAPSHOT_ID = '87878787-8787-4787-8787-878787878787';
const SECOND_SNAPSHOT_ID = '89898989-8989-4989-8989-898989898989';
const REPORT_ID = '88888888-8888-4888-8888-888888888888';
const ASSET_ONE = 'amzn1.assetlibrary.asset1.synthetic-one';
const ASSET_TWO = 'amzn1.assetlibrary.asset1.synthetic-two';

const PROFILE: AdsProfileContext = {
  id: PROFILE_ID,
  orgId: ORG_ID,
  amazonProfileId: '999999999999999',
  region: 'NA',
  currencyCode: 'USD',
  timezone: 'UTC',
};

describe('observed SB Video snapshot ingestion', () => {
  it('counts every coverage state and maps Asset ID with creativeId null', async () => {
    const ads = adsPage([
      ad('ad-mapped', { creativeVersion: 'version_v1', videoAssets: [reference(ASSET_ONE)] }),
      ad('ad-ambiguous', { videoAssets: [reference(ASSET_ONE), reference(ASSET_TWO)] }),
      ad(null, { videoAssets: [reference(ASSET_ONE)] }),
      ad('ad-unmatched', { videoAssets: [reference(`${ASSET_ONE}.missing`)] }),
      ad('ad-unsupported', { videoAssets: [reference('asset-image')] }),
    ]);
    const assets = assetsPage([
      asset(ASSET_ONE, 'VIDEO'),
      asset(ASSET_TWO, 'VIDEO'),
      asset('asset-image', 'IMAGE'),
    ]);
    const store = new MemoryStore();
    const runtime = new ObservedSbVideoIngestion(client(ads, assets), store, fixedNow);

    const result = await runtime.syncSnapshot({
      jobId: SNAPSHOT_ID,
      profile: PROFILE,
      payload: {
        type: 'creative.sync',
        orgId: ORG_ID,
        profileId: PROFILE_ID,
        adProduct: 'SB',
        startDate: '2026-08-28',
        endDate: '2026-08-28',
      },
    });

    expect(result).toMatchObject({
      status: 'mapping_only',
      sourceAssets: 3,
      parsedAssets: 3,
      sourceAds: 5,
      parsedAds: 5,
      mapped: 1,
      legacy: 1,
      unsupported: 1,
      ambiguous: 1,
      unmapped: 1,
      assetsUpserted: 2,
      mappingsUpserted: 4,
      reportEnqueued: false,
      amazonWriteCalls: 0,
    });
    const mapped = store.lastBatch?.mappings.find(({ mapping }) =>
      mapping.attributionState === 'mapped')?.mapping;
    expect(mapped).toMatchObject({
      adId: 'ad-mapped',
      creativeId: null,
      creativeVersion: 'version_v1',
      assetId: ASSET_ONE,
      placement: null,
      mappingProvenance: 'current_sb_ad_snapshot',
    });
    expect(store.lastBatch?.assets.map((row) => row.assetId).sort()).toEqual([
      ASSET_ONE,
      ASSET_TWO,
    ]);
  });

  it('fails closed on incomplete pagination with zero canonical promotion', async () => {
    const store = new MemoryStore();
    const runtime = new ObservedSbVideoIngestion(
      client(
        { ...adsPage([ad('ad-one')]), nextToken: 'next-page', totalResults: 2 },
        assetsPage([asset(ASSET_ONE, 'VIDEO')]),
      ),
      store,
      fixedNow,
    );
    const result = await runtime.syncSnapshot({
      jobId: SNAPSHOT_ID,
      profile: PROFILE,
      payload: {
        type: 'creative.sync', orgId: ORG_ID, profileId: PROFILE_ID, adProduct: 'SB',
        startDate: '2026-08-29', endDate: '2026-08-29',
        allowObservedAttributionFacts: true,
      },
    });

    expect(result).toMatchObject({
      status: 'blocked',
      assetsUpserted: 0,
      mappingsUpserted: 0,
      reportEnqueued: false,
      reasons: ['pagination_incomplete'],
    });
    expect(store.lastBatch).toMatchObject({ assets: [], mappings: [], facts: [] });
    expect(store.lastBatch?.snapshot?.paginationComplete).toBe(false);
  });

  it('retries idempotently and enqueues one existing-lifecycle report', async () => {
    const store = new MemoryStore();
    const runtime = new ObservedSbVideoIngestion(
      client(adsPage([ad('ad-one')]), assetsPage([asset(ASSET_ONE, 'VIDEO')])),
      store,
      fixedNow,
    );
    const input = {
      jobId: SNAPSHOT_ID,
      profile: PROFILE,
      payload: {
        type: 'creative.sync' as const,
        orgId: ORG_ID,
        profileId: PROFILE_ID,
        adProduct: 'SB' as const,
        startDate: '2026-08-29',
        endDate: '2026-08-29',
        allowObservedAttributionFacts: true,
      },
    };

    expect((await runtime.syncSnapshot(input)).reportEnqueued).toBe(true);
    expect((await runtime.syncSnapshot(input)).reportEnqueued).toBe(false);
    expect(store.snapshots.size).toBe(1);
    expect(store.mappings.size).toBe(1);
    expect(store.enqueued).toEqual([{
      reportType: 'sbAds',
      creativeSyncSnapshotId: SNAPSHOT_ID,
      dedupeKey: `sbAds:${SNAPSHOT_ID}`,
    }]);
  });

  it('rejects an overlapping observation while one report snapshot is pending', async () => {
    const store = new MemoryStore();
    const runtime = new ObservedSbVideoIngestion(
      client(adsPage([ad('ad-one')]), assetsPage([asset(ASSET_ONE, 'VIDEO')])),
      store,
      fixedNow,
    );
    await runtime.syncSnapshot({
      jobId: SNAPSHOT_ID,
      profile: PROFILE,
      payload: {
        type: 'creative.sync', orgId: ORG_ID, profileId: PROFILE_ID, adProduct: 'SB',
        startDate: '2026-08-29', endDate: '2026-08-29',
        allowObservedAttributionFacts: true,
      },
    });

    await expect(runtime.syncSnapshot({
      jobId: SECOND_SNAPSHOT_ID,
      profile: PROFILE,
      payload: {
        type: 'creative.sync', orgId: ORG_ID, profileId: PROFILE_ID, adProduct: 'SB',
        startDate: '2026-08-29', endDate: '2026-08-29',
      },
    })).rejects.toThrow(/still has a report pending/);
    expect(store.mappings.values().next().value?.mapping.creativeSyncSnapshotId)
      .toBe(SNAPSHOT_ID);
  });

  it('promotes only complete one-to-one rows with observed provenance and no placement', async () => {
    const store = new MemoryStore();
    const runtime = new ObservedSbVideoIngestion(
      client(adsPage([ad('ad-one')]), assetsPage([asset(ASSET_ONE, 'VIDEO')])),
      store,
      fixedNow,
    );
    await runtime.syncSnapshot({
      jobId: SNAPSHOT_ID,
      profile: PROFILE,
      payload: {
        type: 'creative.sync', orgId: ORG_ID, profileId: PROFILE_ID, adProduct: 'SB',
        startDate: '2026-08-29', endDate: '2026-08-29',
        allowObservedAttributionFacts: true,
      },
    });
    const result = await runtime.ingestReport({
      profile: PROFILE,
      ledger: {
        id: REPORT_ID,
        orgId: ORG_ID,
        profileId: PROFILE_ID,
        reportType: 'sbAds',
        startDate: '2026-08-29',
        endDate: '2026-08-29',
        source: 'amazon_api',
        amazonReportId: 'report-provider-one',
        requestedAt: new Date('2026-08-29T00:01:00Z'),
        pollAttempts: 1,
        creativeSyncSnapshotId: SNAPSHOT_ID,
      },
      rawRows: [reportRow()],
    });

    expect(result).toMatchObject({
      blocked: false,
      reportSourceRows: 1,
      reportParsedRows: 1,
      mappedFactRows: 1,
      unpromotedReportRows: 0,
      factsUpserted: 1,
      factsReadBack: 1,
      amazonWriteCalls: 0,
    });
    expect(store.lastBatch?.facts[0]).toMatchObject({
      adId: 'ad-one',
      creativeId: null,
      creativeVersion: 'version_v1',
      assetId: ASSET_ONE,
      placement: null,
      mappingProvenance: 'current_sb_ad_snapshot',
      creativeSyncSnapshotId: SNAPSHOT_ID,
    });

    const retry = await runtime.ingestReport({
      profile: PROFILE,
      ledger: ledger(),
      rawRows: [reportRow()],
    });
    expect(retry).toMatchObject({
      blocked: false,
      idempotentReplay: true,
      mappedFactRows: 1,
      factsUpserted: 0,
      factsReadBack: 1,
    });
  });

  it('blocks every fact when the report repeats an ad/date grain', async () => {
    const store = new MemoryStore();
    const runtime = new ObservedSbVideoIngestion(
      client(adsPage([ad('ad-one')]), assetsPage([asset(ASSET_ONE, 'VIDEO')])),
      store,
      fixedNow,
    );
    await runtime.syncSnapshot({
      jobId: SNAPSHOT_ID,
      profile: PROFILE,
      payload: {
        type: 'creative.sync', orgId: ORG_ID, profileId: PROFILE_ID, adProduct: 'SB',
        startDate: '2026-08-29', endDate: '2026-08-29',
        allowObservedAttributionFacts: true,
      },
    });
    const result = await runtime.ingestReport({
      profile: PROFILE,
      ledger: ledger(),
      rawRows: [reportRow(), reportRow()],
    });
    expect(result).toMatchObject({
      blocked: true,
      mappedFactRows: 0,
      factsUpserted: 0,
      reasons: ['duplicate_ad_date_rows'],
    });
    expect(store.lastBatch).toMatchObject({ assets: [], mappings: [], facts: [] });
  });

  it('refuses the observed-fact gate for a multi-day backfill before any Amazon read', async () => {
    let reads = 0;
    const api: SbVideoContractProbeClient = {
      probeSbAdsPage: async () => (reads += 1, adsPage([])),
      probeCreativeAssetsPage: async () => (reads += 1, assetsPage([])),
    };
    const runtime = new ObservedSbVideoIngestion(api, new MemoryStore(), fixedNow);
    await expect(runtime.syncSnapshot({
      jobId: SNAPSHOT_ID,
      profile: PROFILE,
      payload: {
        type: 'creative.sync', orgId: ORG_ID, profileId: PROFILE_ID, adProduct: 'SB',
        startDate: '2026-08-27', endDate: '2026-08-28',
        allowObservedAttributionFacts: true,
      },
    })).rejects.toThrow(/historical backfill is disabled/);
    expect(reads).toBe(0);
  });

  it.each(['2026-08-28', '2026-08-30'])(
    'refuses non-observation fact date %s before any Amazon read',
    async (date) => {
      let reads = 0;
      const api: SbVideoContractProbeClient = {
        probeSbAdsPage: async () => (reads += 1, adsPage([])),
        probeCreativeAssetsPage: async () => (reads += 1, assetsPage([])),
      };
      const runtime = new ObservedSbVideoIngestion(api, new MemoryStore(), fixedNow);
      await expect(runtime.syncSnapshot({
        jobId: SNAPSHOT_ID,
        profile: PROFILE,
        payload: {
          type: 'creative.sync', orgId: ORG_ID, profileId: PROFILE_ID, adProduct: 'SB',
          startDate: date, endDate: date,
          allowObservedAttributionFacts: true,
        },
      })).rejects.toThrow(/profile-local observation date 2026-08-29/);
      expect(reads).toBe(0);
    },
  );

  it('uses the profile timezone when resolving the observation date', async () => {
    const store = new MemoryStore();
    const runtime = new ObservedSbVideoIngestion(
      client(adsPage([ad('ad-one')]), assetsPage([asset(ASSET_ONE, 'VIDEO')])),
      store,
      fixedNow,
    );
    const result = await runtime.syncSnapshot({
      jobId: SNAPSHOT_ID,
      profile: { ...PROFILE, timezone: 'America/Los_Angeles' },
      payload: {
        type: 'creative.sync', orgId: ORG_ID, profileId: PROFILE_ID, adProduct: 'SB',
        startDate: '2026-08-28', endDate: '2026-08-28',
        allowObservedAttributionFacts: true,
      },
    });
    expect(result.status).toBe('report_pending');
  });
});

class MemoryStore implements SbVideoIngestionStore {
  lastBatch: CreativePerformanceWriteBatch | undefined;
  snapshots = new Map<string, CreativeSyncSnapshotEvidence['snapshot']>();
  mappings = new Map<string, CreativeMappingWrite>();
  persistence = new Map<string, CreativeSyncSnapshotEvidence['persistence']>();
  enqueued: Array<{ reportType: string; creativeSyncSnapshotId: string | null | undefined; dedupeKey: string }> = [];
  private dedupe = new Set<string>();

  async persist(batch: CreativePerformanceWriteBatch): Promise<CreativePersistenceCounts> {
    if (
      batch.snapshot !== undefined &&
      (batch.snapshot.status === 'mapping_only' || batch.snapshot.status === 'report_pending')
    ) {
      const pending = [...this.snapshots.values()].find((snapshot) =>
        snapshot.profileId === batch.profileId && snapshot.status === 'report_pending');
      if (pending !== undefined && pending.id !== batch.snapshot.id) {
        throw new Error(`creative snapshot ${pending.id} still has a report pending`);
      }
    }
    this.lastBatch = batch;
    if (batch.snapshot) this.snapshots.set(batch.snapshot.id, batch.snapshot);
    for (const mapping of batch.mappings) this.mappings.set(mapping.sourceMappingKey, mapping);
    const snapshots = batch.snapshot === undefined ? 0 : 1;
    const counts = {
      assetsUpserted: batch.assets.length,
      mappingsUpserted: batch.mappings.length,
      factsUpserted: batch.facts.length,
      totalUpserts: batch.assets.length + batch.mappings.length + batch.facts.length + snapshots,
      assetsReadBack: batch.assets.length,
      mappingsReadBack: batch.mappings.length,
      factsReadBack: batch.facts.length,
      snapshotsUpserted: snapshots,
      snapshotsReadBack: snapshots,
    };
    if (batch.snapshot !== undefined) {
      const previous = this.persistence.get(batch.snapshot.id);
      this.persistence.set(batch.snapshot.id, {
        assetsUpserted: Math.max(previous?.assetsUpserted ?? 0, counts.assetsUpserted),
        mappingsUpserted: Math.max(previous?.mappingsUpserted ?? 0, counts.mappingsUpserted),
        factsUpserted: Math.max(previous?.factsUpserted ?? 0, counts.factsUpserted),
        assetsReadBack: Math.max(previous?.assetsReadBack ?? 0, counts.assetsReadBack),
        mappingsReadBack: Math.max(previous?.mappingsReadBack ?? 0, counts.mappingsReadBack),
        factsReadBack: Math.max(previous?.factsReadBack ?? 0, counts.factsReadBack),
      });
    }
    return counts;
  }

  async evidence(scope: {
    orgId: string;
    profileId: string;
    snapshotId: string;
  }): Promise<CreativeSyncSnapshotEvidence> {
    const snapshot = this.snapshots.get(scope.snapshotId);
    if (!snapshot) throw new Error('missing synthetic snapshot');
    return {
      snapshot,
      mappings: [...this.mappings.values()].filter(({ mapping }) =>
        mapping.creativeSyncSnapshotId === scope.snapshotId),
      persistence: this.persistence.get(scope.snapshotId) ?? {
        assetsUpserted: 0,
        mappingsUpserted: 0,
        factsUpserted: 0,
        assetsReadBack: 0,
        mappingsReadBack: 0,
        factsReadBack: 0,
      },
    };
  }

  async enqueueReport(
    payload: Parameters<SbVideoIngestionStore['enqueueReport']>[0],
    dedupeKey: string,
  ): Promise<boolean> {
    if (this.dedupe.has(dedupeKey)) return false;
    this.dedupe.add(dedupeKey);
    this.enqueued.push({
      reportType: payload.reportType,
      creativeSyncSnapshotId: payload.creativeSyncSnapshotId,
      dedupeKey,
    });
    return true;
  }
}

function client(ads: SbAdProbePage, assets: CreativeAssetProbePage): SbVideoContractProbeClient {
  return {
    probeSbAdsPage: async () => ads,
    probeCreativeAssetsPage: async () => assets,
  };
}

function adsPage(items: SbAdProbeRow[]): SbAdProbePage {
  return { items, sourceRows: items.length, totalResults: items.length, nextToken: null };
}

function assetsPage(items: CreativeAssetProbePage['items']): CreativeAssetProbePage {
  return { items, sourceRows: items.length, totalRecords: items.length, nextToken: null };
}

function ad(
  adId: string | null,
  overrides: Partial<SbAdProbeRow> = {},
): SbAdProbeRow {
  return {
    adId,
    campaignId: 'campaign-one',
    adGroupId: 'ad-group-one',
    creativePresent: true,
    creativeVersion: 'version_v1',
    creativeType: 'VIDEO',
    name: 'Synthetic video ad',
    state: 'ENABLED',
    videoAssets: [reference(ASSET_ONE)],
    asins: ['B000000001'],
    raw: {},
    ...overrides,
  };
}

function reference(assetId: string) {
  return {
    referenceId: `${assetId}:version_v1`,
    assetId,
    version: 'version_v1',
    kind: 'asset_library' as const,
  };
}

function asset(assetId: string, assetType: string): CreativeAssetProbePage['items'][number] {
  return {
    assetId,
    version: 'version_v1',
    assetType,
    name: `Synthetic ${assetType.toLowerCase()}`,
    status: 'ACTIVE',
    contentHash: null,
    defaultUrl: null,
    thumbnailUrl: null,
    raw: {},
  };
}

function reportRow() {
  return {
    date: '2026-08-29',
    campaignId: 'campaign-one',
    adGroupId: 'ad-group-one',
    adId: 'ad-one',
    impressions: 100,
    clicks: 10,
    cost: 5,
    purchases: 2,
    sales: 20,
    videoFirstQuartileViews: 80,
    videoMidpointViews: 60,
    videoThirdQuartileViews: 40,
    videoCompleteViews: 20,
  };
}

function ledger() {
  return {
    id: REPORT_ID,
    orgId: ORG_ID,
    profileId: PROFILE_ID,
    reportType: 'sbAds' as const,
    startDate: '2026-08-29',
    endDate: '2026-08-29',
    source: 'amazon_api',
    amazonReportId: 'report-provider-one',
    requestedAt: new Date('2026-08-29T00:01:00Z'),
    pollAttempts: 1,
    creativeSyncSnapshotId: SNAPSHOT_ID,
  };
}

function fixedNow(): Date {
  return new Date('2026-08-29T00:00:00Z');
}
