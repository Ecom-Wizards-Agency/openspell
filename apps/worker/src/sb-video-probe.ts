/**
 * Sanitized, non-persisting proof of the SB Video identity contract.
 *
 * The result contains counts and readiness reasons only: no profile, campaign,
 * ad, ASIN, asset, name, URL, or response body can escape through this seam.
 */
import type {
  CreativeAssetProbePage,
  SbAdProbePage,
  SbAdsReportProbeParseResult,
} from '@wizard-ads/ads-api';
import type {
  AdsProfileContext,
  SbVideoContractProbeClient,
} from './ads-api.js';

export type SbVideoProbeReason =
  | 'no_video_ads'
  | 'ads_response_paginated'
  | 'ads_total_exceeds_page'
  | 'asset_response_paginated'
  | 'asset_catalog_count_exceeds_page'
  | 'missing_ad_id'
  | 'multiple_video_assets'
  | 'missing_asset_records'
  | 'non_video_asset_reference'
  | 'legacy_media_reference';

export interface SbVideoContractProbeResult {
  status: 'ready_for_report_probe' | 'identity_contract_incomplete';
  ads: {
    sourceRows: number;
    parsedRows: number;
    advertisedTotalResults: number | null;
    videoRows: number;
    videoRowsWithAdId: number;
    singleAssetVideoRows: number;
    assetReferences: number;
    distinctAssetReferences: number;
    assetLibraryReferences: number;
    legacyMediaReferences: number;
  };
  assets: {
    sourceRows: number;
    parsedRows: number;
    advertisedTotalRecords: number | null;
    videoRows: number;
  };
  reconciliation: {
    matchedDistinctAssets: number;
    missingDistinctAssets: number;
    nonVideoDistinctAssets: number;
  };
  reasons: SbVideoProbeReason[];
  persistedRows: 0;
  amazonWriteCalls: 0;
}

export interface SbVideoReportProbeResult {
  status: 'ready_for_persistence_model_review' | 'report_contract_incomplete';
  listing: {
    sourceRows: number;
    parsedRows: number;
    advertisedTotalResults: number | null;
    rowsWithAdId: number;
    rowsWithoutAdId: number;
    duplicateAdIds: number;
  };
  report: {
    sourceRows: number;
    parsedRows: number;
    refusedRows: number;
    rowsWithAdId: number;
    legacyRowsWithoutAdId: number;
    duplicateAdDateRows: number;
  };
  reconciliation: {
    matchedAdRows: number;
    matchedVideoRows: number;
    unmatchedAdRows: number;
    nonVideoRows: number;
    matchedVideoRowsWithAllQuartiles: number;
  };
  reasons: Array<
    | 'no_report_rows'
    | 'ad_list_count_mismatch'
    | 'ad_list_paginated'
    | 'ad_list_total_exceeds_page'
    | 'duplicate_ad_ids'
    | 'listing_rows_without_ad_id'
    | 'refused_report_rows'
    | 'duplicate_ad_date_rows'
    | 'legacy_report_rows'
    | 'unmatched_ad_rows'
    | 'no_matched_video_rows'
    | 'missing_video_metrics'
  >;
  persistedRows: 0;
  amazonWriteCalls: 0;
}

export function summarizeSbVideoContract(
  adsPage: SbAdProbePage,
  assetsPage: CreativeAssetProbePage,
): SbVideoContractProbeResult {
  const videoAds = adsPage.items.filter(
    (ad) => ad.videoAssets.length > 0 || ad.creativeType?.toUpperCase().includes('VIDEO'),
  );
  const references = videoAds.flatMap((ad) => ad.videoAssets);
  const assetLibraryReferences = references.filter((reference) => reference.kind === 'asset_library');
  const legacyMediaReferences = references.filter((reference) => reference.kind === 'legacy_media');
  const distinctReferences = new Set(assetLibraryReferences.map((reference) => reference.assetId));
  const assetById = new Map(assetsPage.items.map((asset) => [asset.assetId, asset]));
  let matchedDistinctAssets = 0;
  let missingDistinctAssets = 0;
  let nonVideoDistinctAssets = 0;
  for (const assetId of distinctReferences) {
    const asset = assetById.get(assetId);
    if (asset === undefined) {
      missingDistinctAssets += 1;
    } else if (!asset.assetType.toUpperCase().includes('VIDEO')) {
      nonVideoDistinctAssets += 1;
    } else {
      matchedDistinctAssets += 1;
    }
  }

  const reasons = new Set<SbVideoProbeReason>();
  if (videoAds.length === 0) reasons.add('no_video_ads');
  if (adsPage.nextToken !== null) reasons.add('ads_response_paginated');
  if (adsPage.totalResults !== null && adsPage.totalResults > adsPage.sourceRows) {
    reasons.add('ads_total_exceeds_page');
  }
  if (assetsPage.nextToken !== null) reasons.add('asset_response_paginated');
  if (
    assetsPage.totalRecords !== null &&
    assetsPage.totalRecords > assetsPage.sourceRows
  ) {
    reasons.add('asset_catalog_count_exceeds_page');
  }
  if (videoAds.some((ad) => ad.adId === null)) reasons.add('missing_ad_id');
  if (videoAds.some((ad) => ad.videoAssets.length > 1)) reasons.add('multiple_video_assets');
  if (missingDistinctAssets > 0) reasons.add('missing_asset_records');
  if (nonVideoDistinctAssets > 0) reasons.add('non_video_asset_reference');
  if (legacyMediaReferences.length > 0) reasons.add('legacy_media_reference');

  const orderedReasons = [...reasons].sort();
  return {
    status: orderedReasons.length === 0
      ? 'ready_for_report_probe'
      : 'identity_contract_incomplete',
    ads: {
      sourceRows: adsPage.sourceRows,
      parsedRows: adsPage.items.length,
      advertisedTotalResults: adsPage.totalResults,
      videoRows: videoAds.length,
      videoRowsWithAdId: videoAds.filter((ad) => ad.adId !== null).length,
      singleAssetVideoRows: videoAds.filter((ad) => ad.videoAssets.length === 1).length,
      assetReferences: references.length,
      distinctAssetReferences: distinctReferences.size,
      assetLibraryReferences: assetLibraryReferences.length,
      legacyMediaReferences: legacyMediaReferences.length,
    },
    assets: {
      sourceRows: assetsPage.sourceRows,
      parsedRows: assetsPage.items.length,
      advertisedTotalRecords: assetsPage.totalRecords,
      videoRows: assetsPage.items.filter((asset) =>
        asset.assetType.toUpperCase().includes('VIDEO')).length,
    },
    reconciliation: {
      matchedDistinctAssets,
      missingDistinctAssets,
      nonVideoDistinctAssets,
    },
    reasons: orderedReasons,
    persistedRows: 0,
    amazonWriteCalls: 0,
  };
}

/** Two sequential Amazon reads followed by pure, redacted reconciliation. */
export async function probeSbVideoContract(
  client: SbVideoContractProbeClient,
  profile: AdsProfileContext,
): Promise<SbVideoContractProbeResult> {
  const adsPage = await client.probeSbAdsPage(profile);
  const assetsPage = await client.probeCreativeAssetsPage(profile);
  return summarizeSbVideoContract(adsPage, assetsPage);
}

/** Exact `adId` reconciliation for an already-downloaded `sbAds` report. */
export function reconcileSbVideoReportProbe(
  adsPage: SbAdProbePage,
  report: SbAdsReportProbeParseResult,
): SbVideoReportProbeResult {
  const adIdCounts = new Map<string, number>();
  for (const ad of adsPage.items) {
    if (ad.adId !== null) adIdCounts.set(ad.adId, (adIdCounts.get(ad.adId) ?? 0) + 1);
  }
  const adById = new Map(
    adsPage.items.flatMap((ad) =>
      ad.adId !== null && adIdCounts.get(ad.adId) === 1 ? [[ad.adId, ad] as const] : []),
  );
  const duplicateAdIds = [...adIdCounts.values()].filter((count) => count > 1).length;
  const listingRowsWithoutAdId = adsPage.items.filter((ad) => ad.adId === null).length;
  const grainCounts = new Map<string, number>();
  for (const row of report.rows) {
    if (row.adId === null) continue;
    const grain = JSON.stringify([row.date, row.adId]);
    grainCounts.set(grain, (grainCounts.get(grain) ?? 0) + 1);
  }
  const duplicateAdDateRows = [...grainCounts.values()]
    .reduce((count, occurrences) => count + Math.max(0, occurrences - 1), 0);

  let matchedAdRows = 0;
  let matchedVideoRows = 0;
  let unmatchedAdRows = 0;
  let nonVideoRows = 0;
  let matchedVideoRowsWithAllQuartiles = 0;
  for (const row of report.rows) {
    if (row.adId === null) continue;
    const ad = adById.get(row.adId);
    if (ad === undefined) {
      unmatchedAdRows += 1;
      continue;
    }
    matchedAdRows += 1;
    if (ad.videoAssets.length === 0) {
      nonVideoRows += 1;
      continue;
    }
    matchedVideoRows += 1;
    if (
      row.videoFirstQuartileViews !== null &&
      row.videoMidpointViews !== null &&
      row.videoThirdQuartileViews !== null &&
      row.videoCompleteViews !== null
    ) {
      matchedVideoRowsWithAllQuartiles += 1;
    }
  }

  const legacyRowsWithoutAdId = report.rows.filter((row) => row.adId === null).length;
  const reasons = new Set<SbVideoReportProbeResult['reasons'][number]>();
  if (adsPage.sourceRows !== adsPage.items.length) reasons.add('ad_list_count_mismatch');
  if (adsPage.nextToken !== null) reasons.add('ad_list_paginated');
  if (adsPage.totalResults !== null && adsPage.totalResults > adsPage.sourceRows) {
    reasons.add('ad_list_total_exceeds_page');
  }
  if (duplicateAdIds > 0) reasons.add('duplicate_ad_ids');
  if (listingRowsWithoutAdId > 0) reasons.add('listing_rows_without_ad_id');
  if (report.sourceRows === 0) reasons.add('no_report_rows');
  if (report.refusals.length > 0) reasons.add('refused_report_rows');
  if (duplicateAdDateRows > 0) reasons.add('duplicate_ad_date_rows');
  if (legacyRowsWithoutAdId > 0) reasons.add('legacy_report_rows');
  if (unmatchedAdRows > 0) reasons.add('unmatched_ad_rows');
  if (matchedVideoRows === 0) reasons.add('no_matched_video_rows');
  if (matchedVideoRowsWithAllQuartiles < matchedVideoRows) reasons.add('missing_video_metrics');
  const orderedReasons = [...reasons].sort();

  return {
    status: orderedReasons.length === 0
      ? 'ready_for_persistence_model_review'
      : 'report_contract_incomplete',
    listing: {
      sourceRows: adsPage.sourceRows,
      parsedRows: adsPage.items.length,
      advertisedTotalResults: adsPage.totalResults,
      rowsWithAdId: adsPage.items.length - listingRowsWithoutAdId,
      rowsWithoutAdId: listingRowsWithoutAdId,
      duplicateAdIds,
    },
    report: {
      sourceRows: report.sourceRows,
      parsedRows: report.parsedRows,
      refusedRows: report.refusals.length,
      rowsWithAdId: report.rows.length - legacyRowsWithoutAdId,
      legacyRowsWithoutAdId,
      duplicateAdDateRows,
    },
    reconciliation: {
      matchedAdRows,
      matchedVideoRows,
      unmatchedAdRows,
      nonVideoRows,
      matchedVideoRowsWithAllQuartiles,
    },
    reasons: orderedReasons,
    persistedRows: 0,
    amazonWriteCalls: 0,
  };
}
